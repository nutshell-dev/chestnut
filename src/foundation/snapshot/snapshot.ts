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
import { NodeFileSystem } from '../fs/node-fs.js';

const GITIGNORE_CONTENT = `stream.jsonl
audit.tsv
logs/
tasks/results/
*.tmp
`;

export class Snapshot {
  private dir: string;
  private fs: NodeFileSystem;
  private consecutiveFailures = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.fs = new NodeFileSystem({ baseDir: dir, enforcePermissions: false });
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
      console.error('[snapshot] init failed, cleaning up .git:', err instanceof Error ? err.message : String(err));
      try { await this.fs.removeDir('.git'); } catch { /* ignore */ }
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
    } catch (err) {
      this.consecutiveFailures++;
      const msg = err instanceof Error ? err.message : String(err);
      if (this.consecutiveFailures >= 3) {
        console.error(`[snapshot] commit failed (${this.consecutiveFailures} consecutive):`, msg);
      } else {
        console.warn('[snapshot] commit failed:', msg);
      }
    }
  }
}
