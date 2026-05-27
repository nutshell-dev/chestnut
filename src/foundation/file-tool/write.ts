/**
 * @module L2.FileTool
 * write tool - Write or append to file
 *
 * Features (MVP aligned):
 * - Auto-backups to clawDir/tasks/sync/ (turn-scoped / cleaned by Snapshot commit)
 * - Overwrite gate: file must be fully read in this session first (phase 487 G6)
 */

import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';

import { backupToSync } from './sync-backup.js';
import { resolveWorkspacePath } from './_resolve-path.js';

export const WRITE_TOOL_NAME = 'write' as const;

export const writeTool: Tool = {
  name: WRITE_TOOL_NAME,
  profiles: ['full', 'subagent', 'miner'],
  group: 'fs-write',
  description: 'Write content to a file. Use append=true to append instead of overwrite. Auto-backups to clawDir/tasks/sync/ (turn-scoped / cleaned by Snapshot commit). For overwrite mode (append=false), file must be fully read in this session first (read without truncation). WARNING: single LLM output is limited to ~4096 tokens (~3000 chars). For long files, split into multiple write calls: first call without append, subsequent calls with append=true.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (default base: workspace root)',
      },
      cwd: {
        type: 'string',
        description: 'Override base for path resolution (relative to workspace root, or absolute, with ".." to escape workspace to claw root). Default: workspace root.',
      },
      content: {
        type: 'string',
        description: 'Content to write',
      },
      append: {
        type: 'boolean',
        description: 'If true, append to file instead of overwriting',
      },
    },
    required: ['path', 'content'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const cwdArg = args.cwd as string | undefined;
    const content = args.content as string;
    const append = args.append === true;

    const resolved = resolveWorkspacePath(ctx, filePath, cwdArg);
    if (resolved.startsWith('..') || resolved.startsWith('/')) {
      return {
        success: false,
        content: `Error: Path escapes claw directory: "${filePath}"${cwdArg ? ` (cwd: ${cwdArg})` : ''}`,
      };
    }

    // Phase430: claw-space boundary check — caller autonomy
    const checker = ctx.permissionChecker;
    if (!checker) {
      throw new Error('FileTool.write: ctx.permissionChecker not injected (Assembly should inject via createClawPermissionChecker)');
    }
    checker.resolveAndCheck(resolved, 'write');

    // overwrite gate (phase 487 G6 (a) / append 不 gate)
    if (!append) {
      const exists = await ctx.fs.exists(resolved);
      if (exists && !ctx.fullyReadPaths.has(resolved)) {
        return {
          success: false,
          content: `Error: 'overwrite' mode requires fully-read first. Path '${filePath}' was not fully read in this session. Use append=true, or read the file first (without truncation).`,
        };
      }
    }

    try {
      let backupPath: string | null = null;
      if (!append) {
        backupPath = await backupToSync(ctx, resolved, 'file_backup');
      }

      if (append) {
        await ctx.fs.append(resolved, content);
      } else {
        await ctx.fs.writeAtomic(resolved, content);
        // overwrite 写成功时 add fullyReadPaths (append 不 add)
        ctx.fullyReadPaths.add(resolved);
      }

      const backupHint = backupPath ? ` (backup: ${backupPath})` : '';
      return { success: true, content: `Written: ${filePath} (${content.length} chars)${backupHint}` };
    } catch (error) {
      return {
        success: false,
        content: `Error writing file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
