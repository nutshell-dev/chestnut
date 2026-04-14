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
import type { IFileSystem } from '../fs/types.js';

const GITIGNORE_CONTENT = `stream.jsonl
audit.tsv
logs/
tasks/results/
*.tmp
`;

let consecutiveCommitFailures = 0;

async function git(dir: string, args: string[]): Promise<string> {
  // 所有参数用单引号包裹，防止 shell 注入
  const cmd = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const result = await exec(`git ${cmd}`, { cwd: dir });
  return result.stdout.trim();
}

/**
 * Idempotent: skip if .git already exists.
 * Write .gitignore → git init → set local user config → empty commit to ensure HEAD exists.
 */
export async function init(dir: string, fs: IFileSystem): Promise<void> {
  if (await fs.exists('.git')) return;
  try {
    await fs.writeAtomic('.gitignore', GITIGNORE_CONTENT);
    await git(dir, ['init']);
    await git(dir, ['config', 'user.name', 'clawforum']);
    await git(dir, ['config', 'user.email', 'clawforum@local']);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '--allow-empty', '-m', 'init']);
  } catch (err) {
    console.error('[snapshot] init failed, cleaning up .git:', err instanceof Error ? err.message : String(err));
    // 清理部分初始化的 .git，下次 init 可以重试
    try {
      await fs.removeDir('.git');
    } catch {
      // 清理也失败则无法恢复，但至少不锁定
    }
  }
}

/**
 * If there are uncommitted changes, execute git add . && git commit. No-op when no changes.
 */
export async function commit(dir: string, message: string): Promise<void> {
  try {
    const status = await git(dir, ['status', '--porcelain']);
    if (!status) {
      consecutiveCommitFailures = 0;  // 成功的 status 调用重置计数
      return;
    }
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', message]);
    consecutiveCommitFailures = 0;
  } catch (err) {
    consecutiveCommitFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    if (consecutiveCommitFailures >= 3) {
      console.error(`[snapshot] commit failed (${consecutiveCommitFailures} consecutive):`, msg);
    } else {
      console.warn('[snapshot] commit failed:', msg);
    }
  }
}
