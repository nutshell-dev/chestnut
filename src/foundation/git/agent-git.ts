/**
 * Agent Git - Git version control for agent directories
 * 
 * Each agent directory has its own git repo:
 * - initAgentGit: Idempotent git init with .gitignore
 * - commitAgentDir: Auto-commit working tree changes
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
export async function initAgentGit(dir: string, fs: IFileSystem): Promise<void> {
  if (await fs.exists('.git')) return;
  try {
    await fs.writeAtomic('.gitignore', GITIGNORE_CONTENT);
    await git(dir, ['init']);
    await git(dir, ['config', 'user.name', 'clawforum']);
    await git(dir, ['config', 'user.email', 'clawforum@local']);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '--allow-empty', '-m', 'init']);
  } catch (err) {
    console.warn('[git] initAgentGit failed:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * If there are uncommitted changes, execute git add . && git commit. No-op when no changes.
 */
export async function commitAgentDir(dir: string, message: string, fs: IFileSystem): Promise<void> {
  try {
    const status = await git(dir, ['status', '--porcelain']);
    if (!status) return;
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', message]);
  } catch (err) {
    console.warn('[git] commitAgentDir failed:', err instanceof Error ? err.message : String(err));
  }
}
