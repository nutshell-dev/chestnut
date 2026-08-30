import * as path from 'path';
import type { ExecContext } from '../tools/index.js';

type WorkspacePathContext = Pick<ExecContext, 'clawDir' | 'workspaceDir'>;

/**
 * Resolve file tool path argument against workspaceDir (default) or explicit cwd.
 * Returns clawDir-relative path for ctx.fs operations + PermissionChecker.
 *
 * phase 517 / α + α.1: 默认 workspaceDir-relative / cwd 显式 override
 * phase 519: cwd 改 workspace-relative（unix shell cd 直觉 / claw root escape via '..'）
 *
 * @param ctx ExecContext with clawDir + workspaceDir
 * @param relPath path arg from LLM (relative or absolute)
 * @param cwdArg optional cwd arg (relative to workspaceDir / or absolute / '..' escapes workspace)
 * @returns clawDir-relative resolved path（或 absolute path 跨出 clawDir 时）
 */
/**
 * NOTE phase 1390: read/write/ls/edit/multi_edit 5 file tool 不再传 cwdArg、转而 path 内直接含相对路径段（path resolve 已规约 `..`）。
 * cwdArg 仅 search.ts 仍用（递归扫描根独立语义）。
 */
export function resolveWorkspacePath(
  ctx: WorkspacePathContext,
  relPath: string,
  cwdArg?: string,
): string {
  // phase 519: cwd resolved against workspaceDir (unix shell cd 直觉)
  // claw root escape via cwd: '..' / claw root subdirs via cwd: '../memory' etc.
  // path traversal escape claw root 由 caller path.relative + startsWith('..') 自检 reject
  const baseDir = cwdArg
    ? (path.isAbsolute(cwdArg) ? cwdArg : path.resolve(ctx.workspaceDir, cwdArg))
    : ctx.workspaceDir;
  const absolute = path.isAbsolute(relPath)
    ? relPath
    : path.resolve(baseDir, relPath);
  return path.relative(ctx.clawDir, absolute);
}
