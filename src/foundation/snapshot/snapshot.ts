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
import type { FileSystem } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import { SNAPSHOT_AUDIT_EVENTS } from './audit-events.js';
import { ok, err as errResult, type Result } from '../../types/result.js';
import { classifyGitError, type ExpectedGitFailure } from './git-errors.js';
import { AUDIT_MESSAGE_MAX_CHARS } from '../audit/index.js';

const DEFAULT_IGNORES = ['logs/', '*.tmp'];

function toGitExecError(e: unknown): { code?: string; exitCode?: number; signal?: string; output?: string; message: string } {
  if (e instanceof Error) {
    return {
      code: (e as any).code,
      exitCode: (e as any).exitCode,
      signal: (e as any).signal,
      output: (e as any).output,
      message: e.message,
    };
  }
  return { message: String(e) };
}

export class Snapshot {
  private dir: string;
  private fs: FileSystem;
  private consecutiveFailures = 0;
  private readonly audit: AuditLog;
  private readonly ignorePatterns: readonly string[];
  private readonly syncCleanupDirs?: readonly string[];

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

  private static async git(dir: string, args: string[]): Promise<string> {
    const result = await exec('git', args, { cwd: dir });
    return result.output.trim();
  }

  /**
   * 幂等 git init。
   * - 预期失败 → Result.err + 清理 .git
   * - 不可预期失败（磁盘满 / 权限）→ throw（冒泡给启动流程）
   */
  async init(): Promise<Result<void, ExpectedGitFailure>> {
    const gitDir = path.join(this.dir, '.git');
    if (await this.fs.exists(gitDir)) {
      this.consecutiveFailures = 0;
      return ok(undefined);
    }
    try {
      await this.fs.writeAtomic('.gitignore', this.buildGitignore());
      await Snapshot.git(this.dir, ['init']);
      await Snapshot.git(this.dir, ['config', 'user.name', 'clawforum']);
      await Snapshot.git(this.dir, ['config', 'user.email', 'clawforum@local']);
      await Snapshot.git(this.dir, ['add', '.']);
      await Snapshot.git(this.dir, ['commit', '--allow-empty', '-m', 'init']);
      this.consecutiveFailures = 0;
      return ok(undefined);
    } catch (rawErr) {
      const failure = this.classifyOrThrow(rawErr);
      await this.tryCleanupGit(failure);
      this.audit.write(
        SNAPSHOT_AUDIT_EVENTS.INIT_FAILED,
        `dir=${this.dir}`,
        `kind=${failure.kind}`,
      );
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

  private async tryCleanupGit(failure: ExpectedGitFailure): Promise<void> {
    const gitDir = path.join(this.dir, '.git');
    try {
      await this.fs.removeDir(gitDir);
    } catch (cleanupErr) {
      const reason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      this.audit.write(
        SNAPSHOT_AUDIT_EVENTS.INIT_CLEANUP_FAILED,
        `dir=${this.dir}`,
        `reason=${reason}`,
      );
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
    try {
      const status = await Snapshot.git(this.dir, ['status', '--porcelain']);
      if (!status) {
        this.consecutiveFailures = 0;
        return ok(undefined);
      }
      await Snapshot.git(this.dir, ['add', '.']);
      await Snapshot.git(this.dir, ['commit', '-m', message]);
      this.consecutiveFailures = 0;
      this.audit.write(
        SNAPSHOT_AUDIT_EVENTS.COMMITTED,
        `dir=${this.dir}`,
        `message=${message.slice(0, AUDIT_MESSAGE_MAX_CHARS)}`,
      );

      // whitelist cleanup of specified sync scratch subdirs on commit success
      // (turn-scoped lifecycle / 应然 §A.7 / phase772: 从整 syncDir 清改白名单)
      for (const cleanupDir of (this.syncCleanupDirs ?? [])) {
        try {
          const relDir = path.relative(this.dir, cleanupDir);
          await this.fs.removeDir(relDir);
          await this.fs.ensureDir(relDir);
        } catch (e) {
          // phase 815 P1.33: removeDir+ensureDir 非原子。removeDir 成功 + ensureDir fail（disk full
          // / permission / IO）→ dir 被删未重建 / 后续 turn 写 audit/stream ENOENT crash。
          // best-effort 重建 + audit / 失败也只 audit 不抛（mirror init() cleanup 既有 pattern）
          try {
            const relDir = path.relative(this.dir, cleanupDir);
            await this.fs.ensureDir(relDir);
          } catch { /* audit-only / 真双 fail 推 r+1 emptyDir helper α */ }
          this.audit.write(
            SNAPSHOT_AUDIT_EVENTS.SYNC_CLEAN_FAILED,
            `dir=${cleanupDir}`,
            `reason=${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      return ok(undefined);
    } catch (rawErr) {
      const failure = this.classifyOrThrow(rawErr);
      this.consecutiveFailures++;
      this.audit.write(
        SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED,
        `dir=${this.dir}`,
        `kind=${failure.kind}`,
        `consecutive=${this.consecutiveFailures}`,
      );
      if (this.consecutiveFailures === 3) {
        this.audit.write(
          SNAPSHOT_AUDIT_EVENTS.DEGRADED,
          `dir=${this.dir}`,
          `consecutive=${this.consecutiveFailures}`,
        );
      }
      return errResult(failure);
    }
  }
}
