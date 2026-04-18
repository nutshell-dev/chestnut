/**
 * Snapshot - Git-based version control for agent directories
 *
 * Each agent directory has its own git repo:
 * - init: Idempotent git init with .gitignore
 * - commit: Auto-commit working tree changes
 *
 * All git operations are best-effort; failures are logged but don't block business logic.
 */

import { exec } from '../process-exec/index.js';
import type { FileSystem } from '../fs/types.js';
import type { Audit } from '../audit/index.js';
import { AUDIT_EVENTS } from '../audit/events.js';

const GITIGNORE_CONTENT = `stream.jsonl
audit.tsv
logs/
tasks/results/
*.tmp
`;

export class Snapshot {
  private dir: string;
  private fs: FileSystem;
  private consecutiveFailures = 0;
  private readonly audit: Audit;

  constructor(dir: string, fs: FileSystem, audit: Audit) {
    this.dir = dir;
    this.fs = fs;
    this.audit = audit;
  }

  private static async git(dir: string, args: string[]): Promise<string> {
    // 所有参数用单引号包裹，防止 shell 注入
    const cmd = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    const result = await exec(`git ${cmd}`, { cwd: dir });
    return result.stdout.trim();
  }

  async init(): Promise<void> {
    if (await this.fs.exists('.git')) return;
    try {
      await this.fs.writeAtomic('.gitignore', GITIGNORE_CONTENT);
      await Snapshot.git(this.dir, ['init']);
      await Snapshot.git(this.dir, ['config', 'user.name', 'clawforum']);
      await Snapshot.git(this.dir, ['config', 'user.email', 'clawforum@local']);
      await Snapshot.git(this.dir, ['add', '.']);
      await Snapshot.git(this.dir, ['commit', '--allow-empty', '-m', 'init']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit.write(AUDIT_EVENTS.SNAPSHOT_INIT_FAILED, `reason=${msg.slice(0, 200)}`);
      try {
        await this.fs.removeDir('.git');
      } catch (cleanupErr) {
        const reason = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        this.audit.write(AUDIT_EVENTS.SNAPSHOT_INIT_CLEANUP_FAILED, `dir=${this.dir}`, `reason=${reason}`);
      }
    }
  }

  async commit(message: string): Promise<void> {
    try {
      const status = await Snapshot.git(this.dir, ['status', '--porcelain']);
      if (!status) {
        this.consecutiveFailures = 0;
        return;
      }
      await Snapshot.git(this.dir, ['add', '.']);
      await Snapshot.git(this.dir, ['commit', '-m', message]);
      this.consecutiveFailures = 0;
      this.audit.write(AUDIT_EVENTS.SNAPSHOT_COMMITTED, `message=${message.slice(0, 200)}`);
    } catch (err) {
      this.consecutiveFailures++;
      const reason = err instanceof Error ? err.message : String(err);
      this.audit.write(
        AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED,
        `consecutive=${this.consecutiveFailures}`,
        `reason=${reason.slice(0, 200)}`,
      );
      if (this.consecutiveFailures === 3) {
        this.audit.write(
          AUDIT_EVENTS.SNAPSHOT_DEGRADED,
          `consecutive=${this.consecutiveFailures}`,
          `reason=${reason.slice(0, 200)}`,
        );
      }
    }
  }
}
