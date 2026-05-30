/**
 * @module L2.FileTool
 * write tool - Write or append to file.
 *
 * Features (MVP aligned):
 * - Auto-backups to clawDir/tasks/sync/ (turn-scoped / cleaned by Snapshot commit)
 * - Overwrite gate (phase 1430, semantic 1444): uses `readFileState` Map (hash + mtime + isFullRead).
 *   - L1 not-read / partial: reject "File not fully read; read it first before overwriting."
 *     (phase 1444: "fully read" = read covered every current line + no byte-cap truncation;
 *      explicit `limit >= totalLines` counts.)
 *   - L2 stale: reject "File modified since read; read it again before overwriting."
 */

import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';

import { backupToSync } from './sync-backup.js';
import { resolveWorkspacePath } from './resolve-path.js';
import { computeContentHash } from './file-state.js';
import { enforceFullReadGate } from './fullread-gate.js';

export const WRITE_TOOL_NAME = 'write' as const;

export const writeTool: Tool = {
  name: WRITE_TOOL_NAME,
  profiles: ['full', 'subagent', 'miner'],
  group: 'fs-write',
  description: 'Write a file. Path resolves against your clawspace; use "../" to access claw root (e.g. "../MEMORY.md", "../memory/notes.md"). Set append: true to append. Overwrite (no append) requires a prior `read` that covered every current line of the file (no byte-cap truncation) and the file unchanged since that read.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (workspace-relative, "../" allowed for claw root access)',
      },
      content: {
        type: 'string',
        description: 'Content to write',
      },
      append: {
        type: 'boolean',
        description: 'If true, append to file instead of overwriting (bypasses the overwrite gate).',
      },
    },
    required: ['path', 'content'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const content = args.content as string;
    const append = args.append === true;

    const resolved = resolveWorkspacePath(ctx, filePath);
    if (resolved.startsWith('..') || resolved.startsWith('/')) {
      return {
        success: false,
        content: `Error: Path escapes claw root: "${filePath}"`,
      };
    }

    // Phase430: claw-space boundary check — caller autonomy
    const checker = ctx.permissionChecker;
    if (!checker) {
      throw new Error('FileTool.write: ctx.permissionChecker not injected (Assembly should inject via createClawPermissionChecker)');
    }
    checker.resolveAndCheck(resolved, 'write');

    // overwrite gate — phase 1430 (inlined) → phase 1447 (shared helper).
    // Only triggers for `overwrite` mode on an existing file; new-file create
    // and append both bypass.
    if (!append) {
      const exists = await ctx.fs.exists(resolved);
      if (exists) {
        const gateError = await enforceFullReadGate(ctx, resolved, filePath);
        if (gateError) {
          return {
            success: false,
            content: gateError.content + ` For files where the response would exceed 100 KB, use edit/multi_edit, or write with append:true.`,
          };
        }
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
        // overwrite 写成功 → 更新 readFileState（写入的就是新全文）
        const newStat = await ctx.fs.stat(resolved);
        ctx.readFileState.set(resolved, {
          hash: computeContentHash(content),
          timestamp: newStat.mtime.getTime(),
          isFullRead: true,
        });
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
