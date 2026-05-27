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
import { exec } from '../process-exec/index.js';
import { isFileNotFound, type FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import {
  emitSnapshotCommitFailed,
  emitSnapshotCommitted,
  emitSnapshotDegraded,
  emitSnapshotInitCleanupFailed,
  emitSnapshotInitFailed,
  emitSnapshotPersistFailed,
  emitSnapshotRealpathFailed,
  emitSnapshotStateCorrupt,
  emitSnapshotStatusStderr,
  emitSnapshotSyncCleanFailed,
  emitSnapshotSyncRestoreFailed,
  emitSnapshotTryClearFailed,
} from './audit-emit.js';
import { ok, err as errResult, type Result } from '../utils/result.js';
import { classifyGitError, type ExpectedGitFailure, type GitExecError } from './git-errors.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../audit/index.js';

// Node.js child_process / exec 抛错时未声明的 dynamic property
// 显式 Error & Partial<GitExecError> intersection 替 `(e as any)`、编译期可检 Partial 字段
type NodeExecError = Error & Partial<GitExecError>;

const DEFAULT_IGNORES = ['logs/', '*.tmp'];

/** Minimum interval between git commits (ms). Commits within this window are skipped. */
const COMMIT_THROTTLE_MS = 30_000;

// ---- module-level singleton state (cross-instance consecutiveFailures) ----

interface SnapshotState {
  consecutiveFailures: number;
  degradedAt?: number;
}

const _stateMap = new Map<string, SnapshotState>();

function getState(dir: string): SnapshotState {
  let s = _stateMap.get(dir);
  if (!s) {
    s = { consecutiveFailures: 0 };
    _stateMap.set(dir, s);
  }
  return s;
}

const STATE_FILE = '.snapshot-state.json';

function stateFilePath(dir: string): string {
  return path.join(dir, '.git', STATE_FILE);
}

async function persistState(fs: FileSystem, dir: string, state: SnapshotState, audit?: AuditLog): Promise<void> {
  try {
    await fs.writeAtomic(stateFilePath(dir), JSON.stringify(state));
  } catch {
    // silent: persist fail 不抛，下轮 load 最多丢 1 inc
    if (audit) {
      emitSnapshotPersistFailed(audit, { dir, reason: 'writeAtomic failed' });
    }
  }
}

async function tryClearPersist(fs: FileSystem, dir: string, audit?: AuditLog): Promise<void> {
  try {
    await fs.delete(stateFilePath(dir));
  } catch (e) {
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(e) && audit) {
      emitSnapshotTryClearFailed(audit, { dir, reason: (e as Error).message });
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
  private _lastCommitMs = 0;

  constructor(dir: string, fs: FileSystem, audit: AuditLog, ignorePatterns: readonly string[], syncCleanupDirs?: readonly string[]) {
    this.dir = dir;
    this.fs = fs;
    this.audit = audit;
    this.ignorePatterns = ignorePatterns;
    this.syncCleanupDirs = syncCleanupDirs;
  }

  private buildGitignore(): string {
    return [...this.ignorePatterns, ...DEFAULT_IGNORES].join('\n') + '\n';
  }

  private static async git(dir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const result = await exec('git', args, { cwd: dir });
    return { stdout: result.output.trim(), stderr: result.stderr?.trim() ?? '' };
  }

  /**
   * 幂等 git init。
   * - 预期失败 → Result.err + 清理 .git
   * - 不可预期失败（磁盘满 / 权限）→ throw（冒泡给启动流程）
   */
  async init(): Promise<Result<void, ExpectedGitFailure>> {
    const gitDir = path.join(this.dir, '.git');
    // load persisted state (cross-reassemble continuity)
    try {
      const sf = stateFilePath(this.dir);
      if (await this.fs.exists(sf)) {
        const raw = await this.fs.read(sf);
        const loaded = JSON.parse(raw) as Partial<SnapshotState>;
        const s = getState(this.dir);
        if (typeof loaded.consecutiveFailures === 'number' && loaded.consecutiveFailures > 0) {
          s.consecutiveFailures = loaded.consecutiveFailures;
          s.degradedAt = loaded.degradedAt;
          // audit: restored prior failures from disk
          emitSnapshotCommitFailed(this.audit, {
            dir: this.dir,
            context: 'state_restored_from_disk',
            consecutive: s.consecutiveFailures,
          });
        }
      }
    } catch (e) {
      emitSnapshotStateCorrupt(this.audit, { reason: (e as Error).message });
    }
    let shouldResetCounter = false;
    if (await this.fs.exists(gitDir)) {
      // Post-init integrity check: a repo is only ready if HEAD exists
      // (git init + git commit completed). If init crashed between git init
      // and git commit, .git exists but HEAD does not → commit() would fail.
      try {
        const head = await Snapshot.git(this.dir, ['rev-parse', 'HEAD']);
        if (head.stdout) {
          // idempotent: do NOT reset counter (preserve cross-reassemble failure history)
          return ok(undefined);
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
      await this.fs.writeAtomic(path.join(this.dir, '.gitignore'), this.buildGitignore());
      await Snapshot.git(this.dir, ['init']);
      await Snapshot.git(this.dir, ['config', 'user.name', 'clawforum']);
      await Snapshot.git(this.dir, ['config', 'user.email', 'clawforum@local']);
      await Snapshot.git(this.dir, ['add', '.']);
      await Snapshot.git(this.dir, ['commit', '--allow-empty', '-m', 'init']);
      if (shouldResetCounter) {
        const s = getState(this.dir);
        s.consecutiveFailures = 0;
        if (!s.degradedAt) {
          _stateMap.delete(this.dir);
        }
      }
      return ok(undefined);
    } catch (rawErr) {
      const failure = this.classifyOrThrow(rawErr);
      await this.tryCleanupGit(failure);
      emitSnapshotInitFailed(this.audit, {
        dir: this.dir,
        kind: failure.kind,
      });
      return errResult(failure);
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
    const gitDir = path.join(this.dir, '.git');
    try {
      await this.fs.removeDir(gitDir);
    } catch (cleanupErr) {
      const reason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
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
      const s = getState(this.dir);
      if (s.consecutiveFailures > 0) {
        s.consecutiveFailures = 0;
        await tryClearPersist(this.fs, this.dir, this.audit);
      }
      return ok(undefined);
    }

    try {
      const status = await Snapshot.git(this.dir, ['status', '--porcelain']);
      if (status.stderr) {
        emitSnapshotStatusStderr(this.audit, {
          dir: this.dir,
          stderr: status.stderr.slice(0, 200),
        });
      }
      if (!status.stdout) {
        const s = getState(this.dir);
        s.consecutiveFailures = 0;
        if (!s.degradedAt) {
          _stateMap.delete(this.dir);
        }
        return ok(undefined);
      }
      await Snapshot.git(this.dir, ['add', '.']);
      await Snapshot.git(this.dir, ['commit', '-m', message]);
      this._lastCommitMs = Date.now();
      const s = getState(this.dir);
      s.consecutiveFailures = 0;
      if (!s.degradedAt) {
        _stateMap.delete(this.dir);
      }
      await tryClearPersist(this.fs, this.dir, this.audit);
      emitSnapshotCommitted(this.audit, {
        dir: this.dir,
        message: message.slice(0, AUDIT_MESSAGE_MAX_CHARS),
      });

      // whitelist cleanup of specified sync scratch subdirs on commit success
      // (turn-scoped lifecycle / 应然 §A.7 / phase772: 从整 syncDir 清改白名单)
      // H.2 α-sort-by-depth: deepest first to avoid nested wipe (phase 998)
      const sortedCleanupDirs = [...(this.syncCleanupDirs ?? [])].sort(
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
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        // Resolve this.dir as well to align with resolved (e.g. macOS /var -> /private/var)
        let resolvedDir: string;
        try {
          resolvedDir = await this.fs.realpath(this.dir);
        } catch (e) {
          emitSnapshotRealpathFailed(this.audit, { dir: this.dir, reason: (e as Error).message });
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
              restoreReason: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
            });
          }
          emitSnapshotSyncCleanFailed(this.audit, {
            dir: cleanupDir,
            reason: e instanceof Error ? e.message : String(e),
          });
        }
      }

      return ok(undefined);
    } catch (rawErr) {
      const failure = this.classifyOrThrow(rawErr);
      const s = getState(this.dir);
      s.consecutiveFailures++;
      await persistState(this.fs, this.dir, s, this.audit);
      emitSnapshotCommitFailed(this.audit, {
        dir: this.dir,
        kind: failure.kind,
        consecutive: s.consecutiveFailures,
      });
      if (s.consecutiveFailures === 3) {
        s.degradedAt = Date.now();
        await persistState(this.fs, this.dir, s, this.audit);
        emitSnapshotDegraded(this.audit, {
          dir: this.dir,
          consecutive: s.consecutiveFailures,
        });
      }
      return errResult(failure);
    }
  }
}
