/**
 * Snapshot - Git-based version control for agent directories
 *
 * Each agent directory has its own git repo:
 * - init: Idempotent git init with .gitignore
 * - commit: Auto-commit working tree changes
 *
 * Git failures are classified:
 * - Expected failures → Result.err (degraded, audit, don't block business logic)
 * - Unexpected failures → throw (bubble up for alerting)
 */

import * as path from 'path';
import { formatErr } from "../node-utils/index.js";
import { exec as defaultExec } from '../process-exec/index.js';
import { isFileNotFound, type FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import {
  emitSnapshotCommitFailed,
  emitSnapshotCommitted,
  emitSnapshotDegraded,
  emitSnapshotInitCleanupFailed,
  emitSnapshotInitFailed,
  emitSnapshotLegacySchemaMigrated,
  emitSnapshotPersistFailed,
  emitSnapshotRealpathFailed,
  emitSnapshotStateCorrupt,
  emitSnapshotStatusStderr,
  emitSnapshotSyncCleanFailed,
  emitSnapshotSyncRestoreFailed,
  emitSnapshotTryClearFailed,
} from './audit-emit.js';
import { assertSnapshotStateShape } from './invariants.js';
import { auditSnapshotStateCrossSource } from './state-cross-source-audit.js';
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
import { classifyGitError, type ExpectedGitFailure, type GitExecError } from './git-errors.js';


// Node.js child_process / exec 抛错时未声明的 dynamic property
// 显式 Error & Partial<GitExecError> intersection 替 `(e as any)`、编译期可检 Partial 字段
type NodeExecError = Error & Partial<GitExecError>;

const DEFAULT_IGNORES = ['logs/', '*.tmp'];

/** Minimum interval between git commits (ms). Commits within this window are skipped. */
const COMMIT_THROTTLE_MS = 30_000;

type SnapshotState =
  | { kind: 'ok' }
  | { kind: 'degraded'; failures: number; degradedAt: number };

const INITIAL_STATE: SnapshotState = { kind: 'ok' };

const STATE_FILE_REL = path.join('.git', '.snapshot-state.json');

function onCommitFailure(state: SnapshotState, now: number): SnapshotState {
  if (state.kind === 'ok') {
    return { kind: 'degraded', failures: 1, degradedAt: now };
  }
  return { ...state, failures: state.failures + 1 };
}

function onCommitSuccess(): SnapshotState {
  return { kind: 'ok' };
}

// phase 699: 加 dir param、forensic dir col 显式传递、与同模块其他 emit 形态对齐
function parseSnapshotState(raw: unknown, audit: AuditLog, dir: string): SnapshotState | undefined {
  if (typeof raw !== 'object' || raw === null) {
    emitSnapshotStateCorrupt(audit, { dir, reason: 'state_schema_invalid' });
    return undefined;
  }

  // new tagged-union schema
  if ('kind' in raw) {
    const parsed = raw as { kind?: unknown; failures?: unknown; degradedAt?: unknown };
    if (parsed.kind === 'ok') {
      return { kind: 'ok' };
    }
    if (parsed.kind === 'degraded') {
      const failures = Number(parsed.failures);
      const degradedAt = Number(parsed.degradedAt);
      if (
        Number.isFinite(failures) &&
        Number.isInteger(failures) &&
        failures >= 0 &&
        Number.isFinite(degradedAt)
      ) {
        return { kind: 'degraded', failures, degradedAt };
      }
    }
    emitSnapshotStateCorrupt(audit, { dir, reason: 'state_schema_invalid' });
    return undefined;
  }

  // legacy schema { consecutiveFailures: number; degradedAt?: number }
  if ('consecutiveFailures' in raw) {
    const legacy = raw as { consecutiveFailures?: unknown; degradedAt?: unknown };
    const failures = Number(legacy.consecutiveFailures);
    if (!Number.isFinite(failures) || !Number.isInteger(failures)) {
      emitSnapshotStateCorrupt(audit, { dir, reason: 'legacy_state_schema_invalid' });
      return undefined;
    }
    const degradedAt = legacy.degradedAt === undefined ? undefined : Number(legacy.degradedAt);
    emitSnapshotLegacySchemaMigrated(audit, {
      failures,
      degradedAt: Number.isFinite(degradedAt) ? degradedAt : undefined,
    });
    if (failures > 0) {
      return {
        kind: 'degraded',
        failures,
        degradedAt: Number.isFinite(degradedAt) ? degradedAt! : Date.now(),
      };
    }
    return { kind: 'ok' };
  }

  emitSnapshotStateCorrupt(audit, { dir, reason: 'state_schema_invalid' });
  return undefined;
}

async function persistState(fs: FileSystem, dir: string, state: SnapshotState, audit?: AuditLog): Promise<boolean> {
  if (audit) {
    // phase 275 Step A: shape invariant
    assertSnapshotStateShape(state, audit, dir);
    // phase 275 Step B: state-internal cross-source (sync、不阻 path、不 throw)
    auditSnapshotStateCrossSource(state, audit, Date.now(), dir);
  }

  try {
    await fs.writeAtomic(STATE_FILE_REL, JSON.stringify(state));
    return true;
  } catch (err) {
    // phase 724: catch(err) 绑 err、emit reason=formatErr(err) 保留 err message forensic
    // phase 851: 返回 false 让调用方感知持久化失败、避免状态被伪装为已可靠记录
    if (audit) {
      emitSnapshotPersistFailed(audit, { dir, reason: formatErr(err) });
    }
    return false;
  }
}

async function tryClearPersist(fs: FileSystem, dir: string, audit?: AuditLog): Promise<void> {
  try {
    await fs.delete(STATE_FILE_REL);
  } catch (e) {
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(e) && audit) {
      // phase 725: 改 formatErr(e) 保 stack forensic、与同模块 L292/L408 形态对齐
      emitSnapshotTryClearFailed(audit, { dir, reason: formatErr(e) });
    }
    // ENOENT expected; other errors don't affect function
    // (next init will load + overwrite anyway)
  }
}

function toGitExecError(e: unknown): GitExecError {
  if (e instanceof Error) {
    const ne = e as NodeExecError;
    return {
      code: ne.code,
      exitCode: ne.exitCode,
      signal: ne.signal,
      output: ne.output,
      message: e.message,
    };
  }
  return { message: String(e) };
}

export class Snapshot {
  private dir: string;
  private fs: FileSystem;
  private readonly audit: AuditLog;
  private readonly ignorePatterns: readonly string[];
  private readonly syncCleanupDirs?: readonly string[];
  private execImpl: typeof defaultExec;
  private _lastCommitMs = 0;
  private state: SnapshotState = INITIAL_STATE;

  /**
   * @param dir - snapshot 根目录绝对路径（必须等于 fs.baseDir、调用方装配责任）
   * @param fs - FileSystem 实例、baseDir 必须等于 dir
   * @param audit - 审计日志
   * @param ignorePatterns - gitignore 模式
   * @param syncCleanupDirs - commit 成功后清理的目录白名单
   */
  constructor(dir: string, fs: FileSystem, audit: AuditLog, ignorePatterns: readonly string[], syncCleanupDirs?: readonly string[], execImpl?: typeof defaultExec) {
    this.dir = dir;
    this.fs = fs;
    this.audit = audit;
    this.ignorePatterns = ignorePatterns;
    this.syncCleanupDirs = syncCleanupDirs;
    this.execImpl = execImpl ?? defaultExec;
  }

  private buildGitignore(): string {
    return [...this.ignorePatterns, ...DEFAULT_IGNORES].join('\n') + '\n';
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await this.execImpl('git', args, { cwd: this.dir });
    return { stdout: result.output.trim(), stderr: result.stderr?.trim() ?? '' };
  }

  /**
   * 幂等 git init。
   * - 预期失败 → Result.err + 清理 .git
   * - 不可预期失败（磁盘满 / 权限）→ throw（冒泡给启动流程）
   */
  async init(): Promise<Result<void, ExpectedGitFailure>> {
    // load persisted state (cross-reassemble continuity)
    try {
      if (await this.fs.exists(STATE_FILE_REL)) {
        const raw = await this.fs.read(STATE_FILE_REL);
        const loaded: unknown = JSON.parse(raw);
        const parsed = parseSnapshotState(loaded, this.audit, this.dir);
        if (parsed !== undefined) {
          this.state = parsed;
          if (this.state.kind === 'degraded') {
            // audit: restored prior failures from disk
            emitSnapshotCommitFailed(this.audit, {
              dir: this.dir,
              context: 'state_restored_from_disk',
              consecutive: this.state.failures,
            });
          }
        }
      }
    } catch (e) {
      // phase 725: 改 formatErr(e) 保 stack forensic
      emitSnapshotStateCorrupt(this.audit, { dir: this.dir, reason: formatErr(e) });
    }
    let shouldResetCounter = false;
    if (await this.fs.exists('.git')) {
      // Post-init integrity check: a repo is only ready if HEAD exists
      // (git init + git commit completed). If init crashed between git init
      // and git commit, .git exists but HEAD does not → commit() would fail.
      try {
        const head = await this.git(['rev-parse', 'HEAD']);
        if (head.stdout) {
          // idempotent: do NOT reset counter (preserve cross-reassemble failure history)
          return { ok: true as const, value: undefined };
        }
      } catch {
        // silent: rev-parse failure means incomplete repo — handled by re-init below
      }
      emitSnapshotInitFailed(this.audit, {
        dir: this.dir,
        context: 'incomplete_repo_reinit',
      });
    } else {
      // brand-new repo: reset counter on successful init
      shouldResetCounter = true;
    }
    try {
      await this.fs.writeAtomic('.gitignore', this.buildGitignore());
      await this.git(['init']);
      await this.git(['config', 'user.name', 'chestnut']);
      await this.git(['config', 'user.email', 'chestnut@local']);
      await this.git(['add', '.']);
      // phase 430 Step D (phase 429 Step C consistency): init commit 也加 '--'
      // 与 line 328 user-message commit 一致、消除「hardcoded 'init' 无攻击面所以不
      // 需 --」的不一致 (代码模式一致性优先于 cosmetic 区别)。
      await this.git(['commit', '--allow-empty', '-m', 'init', '--']);
      if (shouldResetCounter) {
        this.state = onCommitSuccess();
      }
      return { ok: true as const, value: undefined };
    } catch (rawErr) {
      const failure = this.classifyOrThrow(rawErr);
      await this.tryCleanupGit(failure);
      emitSnapshotInitFailed(this.audit, {
        dir: this.dir,
        kind: failure.kind,
      });
      return { ok: false as const, error: failure };
    }
  }

  /**
   * Classify a raw git error. Returns the classified failure value if expected
   * (Result.ok), else re-throws the original error (unexpected failures bubble
   * to the startup flow). Shared by init() and commit() catch blocks.
   */
  private classifyOrThrow(rawErr: unknown): ExpectedGitFailure {
    const classified = classifyGitError(toGitExecError(rawErr));
    if (classified.ok) return classified.value;
    throw rawErr;
  }

  private async tryCleanupGit(_failure: ExpectedGitFailure): Promise<void> {
    try {
      await this.fs.removeDir('.git');
    } catch (cleanupErr) {
      const reason = formatErr(cleanupErr);
      emitSnapshotInitCleanupFailed(this.audit, {
        dir: this.dir,
        reason,
      });
      // best-effort cleanup / audit-only / 不 throw / mirror commit() syncDir cleanup / per phase 636
      // init() Result API 契约保 / cleanup 失败不升级为 throw / failure 仍走 errResult 路径
    }
  }

  /**
   * 若无变更跳过；否则 add . && commit。
   * - 预期失败 → Result.err（降级；连续 3 次触发 snapshot_degraded）
   * - 不可预期失败 → throw
   */
  async commit(message: string): Promise<Result<void, ExpectedGitFailure>> {
    // Throttle: skip commits within COMMIT_THROTTLE_MS (phase 1051)
    const now = Date.now();
    if (now - this._lastCommitMs < COMMIT_THROTTLE_MS) {
      // throttle skip counts as "not a failure" — reset counter
      if (this.state.kind === 'degraded') {
        this.state = onCommitSuccess();
        await tryClearPersist(this.fs, this.dir, this.audit);
      }
      return { ok: true as const, value: undefined };
    }

    try {
      const status = await this.git(['status', '--porcelain']);
      if (status.stderr) {
        emitSnapshotStatusStderr(this.audit, {
          dir: this.dir,
          stderr: this.audit.message(status.stderr),
        });
      }
      if (!status.stdout) {
        this.state = onCommitSuccess();
        return { ok: true as const, value: undefined };
      }
      await this.git(['add', '.']);
      // phase 429 Step C (review low defensive): -- 声明 end-of-options、message 含
      // '-' 开头时 git parser 绝不会 mis-treat (defense in depth、当前 -m 已消费 message)
      await this.git(['commit', '-m', message, '--']);
      this._lastCommitMs = Date.now();
      this.state = onCommitSuccess();
      await tryClearPersist(this.fs, this.dir, this.audit);
      emitSnapshotCommitted(this.audit, {
        dir: this.dir,
        message: this.audit.message(message),
      });

      // whitelist cleanup of specified sync scratch subdirs on commit success (§P1 SRP 抽出)
      await this.cleanupSyncDirs();

      return { ok: true as const, value: undefined };
    } catch (rawErr) {
      const failure = this.classifyOrThrow(rawErr);
      this.state = onCommitFailure(this.state, Date.now());
      const persisted = await persistState(this.fs, this.dir, this.state, this.audit);
      const consecutive = this.state.kind === 'degraded' ? this.state.failures : 0;
      emitSnapshotCommitFailed(this.audit, {
        dir: this.dir,
        kind: failure.kind,
        consecutive,
      });
      if (!persisted) {
        // phase 851: git commit 已失败、状态持久化也失败 — 双失败独立 audit、不伪装状态已可靠记录
        emitSnapshotCommitFailed(this.audit, {
          dir: this.dir,
          kind: failure.kind,
          consecutive,
          context: 'persist_failed',
        });
      }
      if (this.state.kind === 'degraded' && this.state.failures === 3) {
        emitSnapshotDegraded(this.audit, {
          dir: this.dir,
          consecutive: this.state.failures,
        });
      }
      return { ok: false as const, error: { ...failure, persistFailed: !persisted } };
    }
  }

  /**
   * Whitelist cleanup of specified sync scratch subdirs after a successful commit.
   *
   * 行为：
   * - 仅 best-effort、cleanup 失败不破坏 commit 已成功的状态
   * - 深度优先排序、内容逐条删除、重建空目录
   * - path escape check：cleanupDir 必须在 this.dir 范围内
   * - realpath resolve 后比对绝对路径（防 symlink 逃逸）
   * - cleanup 异常路径仅 audit、不抛
   *
   * 抽出动机：commit() SRP 治本（snapshot-auditor §P1）— git commit 主流程
   * 与目录清理副作用分离。
   */
  private async cleanupSyncDirs(): Promise<void> {
    if (!this.syncCleanupDirs || this.syncCleanupDirs.length === 0) return;

    // (turn-scoped lifecycle / 应然 §A.7 / phase772: 从整 syncDir 清改白名单)
    // H.2 α-sort-by-depth: deepest first to avoid nested wipe (phase 998)
    const sortedCleanupDirs = [...this.syncCleanupDirs].sort(
      (a, b) => b.split(path.sep).length - a.split(path.sep).length
    );
    for (const cleanupDir of sortedCleanupDirs) {
      const relDir = path.relative(this.dir, cleanupDir);
      if (relDir === '' || relDir.startsWith('..')) {
        emitSnapshotSyncCleanFailed(this.audit, {
          dir: this.dir,
          context: 'empty_or_escaping_relDir',
          cleanupDir,
        });
        continue;
      }

      // H.3 α-realpath-resolve: verify resolved path is within this.dir (phase 998)
      let resolved: string;
      try {
        resolved = await this.fs.realpath(cleanupDir);
      } catch (err) {
        emitSnapshotSyncCleanFailed(this.audit, {
          dir: this.dir,
          context: 'realpath_failed',
          cleanupDir,
          reason: formatErr(err),
        });
        continue;
      }
      // Resolve this.dir as well to align with resolved (e.g. macOS /var -> /private/var)
      let resolvedDir: string;
      try {
        resolvedDir = await this.fs.realpath(this.dir);
      } catch (e) {
        // phase 725: 改 formatErr(e) 保 stack forensic
        emitSnapshotRealpathFailed(this.audit, { dir: this.dir, reason: formatErr(e) });
        resolvedDir = this.dir;
      }
      const relResolved = path.relative(resolvedDir, resolved);
      if (relResolved === '' || relResolved.startsWith('..') || path.isAbsolute(relResolved)) {
        emitSnapshotSyncCleanFailed(this.audit, {
          dir: this.dir,
          context: 'symlink_traversal',
          cleanupDir,
          resolved,
        });
        continue;
      }

      try {
        // H.1 α-content-only-clear: preserve dir invariant to avoid ENOENT race window
        // with concurrent task writer (phase 998). Replaces removeDir+ensureDir.
        const entries = await this.fs.list(relDir, { includeDirs: true });
        for (const entry of entries) {
          const entryPath = path.join(relDir, entry.name);
          if (entry.isDirectory) {
            await this.fs.removeDir(entryPath);
          } else {
            await this.fs.delete(entryPath);
          }
        }
      } catch (e) {
        // phase 815 P1.33: content clear 非原子。clear 成功部分 + ensureDir fail（disk full
        // / permission / IO）→ dir 可能未完全清空 / 后续 turn 写 audit/stream 潜在 crash。
        // best-effort 重建 + audit / 失败也只 audit 不抛（mirror init() cleanup 既有 pattern）
        try {
          await this.fs.ensureDir(relDir);
        } catch (restoreErr) {
          // phase 892: 双 fail 独立 event 区分 outer SYNC_CLEAN_FAILED / mirror init() INIT_CLEANUP_FAILED 模板
          emitSnapshotSyncRestoreFailed(this.audit, {
            dir: cleanupDir,
            restoreReason: formatErr(restoreErr),
          });
        }
        emitSnapshotSyncCleanFailed(this.audit, {
          dir: cleanupDir,
          reason: formatErr(e),
        });
      }
    }
  }
}
