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

const DEFAULT_IGNORES = ['logs/', '*.tmp'];

function toGitExecError(e: unknown): { code?: string; exitCode?: number; signal?: string; stderr?: string; message: string } {
  if (e instanceof Error) {
    return {
      code: (e as any).code,
      exitCode: (e as any).exitCode,
      signal: (e as any).signal,
      stderr: (e as any).stderr,
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

  constructor(dir: string, fs: FileSystem, audit: AuditLog, ignorePatterns: readonly string[]) {
    this.dir = dir;
    this.fs = fs;
    this.audit = audit;
    this.ignorePatterns = ignorePatterns;
  }

  private buildGitignore(): string {
    return [...this.ignorePatterns, ...DEFAULT_IGNORES].join('\n') + '\n';
  }

  private static async git(dir: string, args: string[]): Promise<string> {
    // 所有参数用单引号包裹，防止 shell 注入
    const cmd = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const result = await exec(`git ${cmd}`, { cwd: dir });
    return result.stdout.trim();
  }

  /**
   * 幂等 git init。
   * - 预期失败 → Result.err + 清理 .git
   * - 不可预期失败（磁盘满 / 权限）→ throw（冒泡给启动流程）
   */
  async init(): Promise<Result<void, ExpectedGitFailure>> {
    const gitDir = path.join(this.dir, '.git');
    if (await this.fs.exists(gitDir)) return ok(undefined);
    try {
      await this.fs.writeAtomic('.gitignore', this.buildGitignore());
      await Snapshot.git(this.dir, ['init']);
      await Snapshot.git(this.dir, ['config', 'user.name', 'clawforum']);
      await Snapshot.git(this.dir, ['config', 'user.email', 'clawforum@local']);
      await Snapshot.git(this.dir, ['add', '.']);
      await Snapshot.git(this.dir, ['commit', '--allow-empty', '-m', 'init']);
      return ok(undefined);
    } catch (rawErr) {
      const classified = classifyGitError(toGitExecError(rawErr));
      if (classified.ok) {
        await this.tryCleanupGit(classified.value);
        this.audit.write(
          SNAPSHOT_AUDIT_EVENTS.INIT_FAILED,
          `dir=${this.dir}`,
          `kind=${classified.value.kind}`,
        );
        return errResult(classified.value);
      }
      throw rawErr;
    }
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
      throw cleanupErr;
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
        `message=${message.slice(0, 200)}`,
      );
      return ok(undefined);
    } catch (rawErr) {
      const classified = classifyGitError(toGitExecError(rawErr));
      if (classified.ok) {
        this.consecutiveFailures++;
        this.audit.write(
          SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED,
          `dir=${this.dir}`,
          `kind=${classified.value.kind}`,
          `consecutive=${this.consecutiveFailures}`,
        );
        if (this.consecutiveFailures === 3) {
          this.audit.write(
            SNAPSHOT_AUDIT_EVENTS.DEGRADED,
            `dir=${this.dir}`,
            `consecutive=${this.consecutiveFailures}`,
          );
        }
        return errResult(classified.value);
      }
      throw rawErr;
    }
  }
}
