/**
 * @module L2c.FileTool
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

import { z } from 'zod';
import type { Tool, ExecContext } from '../tools/index.js';
import { formatErr } from "../node-utils/index.js";
import type { ToolResult } from '../tool-protocol/index.js';
import { defineFileToolSchema } from './_zod-helper.js';

import { backupToSync } from './sync-backup.js';
import { resolveWorkspacePath } from './resolve-path.js';
import { recordWriteResult } from './file-state-manager.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';
import { enforceFullReadGate } from './fullread-gate.js';

export const WRITE_TOOL_NAME = 'write' as const;

const WriteInputSchema = z.object({
  path: z.string().describe(
    'File path (workspace-relative, "../" allowed for claw root access)'
  ),
  content: z.string().describe('Content to write'),
  append: z.boolean().optional().describe(
    'If true, append to file instead of overwriting (bypasses the overwrite gate).'
  ),
}).strict();

type WriteInput = z.infer<typeof WriteInputSchema>;

export const writeTool: Tool = {
  name: WRITE_TOOL_NAME,
  profiles: ['full', 'subagent', 'miner'],
  description: 'Write a file. Path resolves against your clawspace; use "../" to access claw root (e.g. "../MEMORY.md", "../memory/notes.md"). Set append: true to append. Overwrite (no append) requires a prior `read` that covered every current line of the file (no byte-cap truncation) and the file unchanged since that read.',
  schema: defineFileToolSchema(WriteInputSchema),
  readonly: false,
  idempotent: false,

  async execute(rawArgs: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    let args: WriteInput;
    try {
      args = WriteInputSchema.parse(rawArgs);
    } catch (err) {
      // phase 695: 拆 tool + error 为两 col、与 phase 692 file-tool 同模式（write.ts 漏补）
      ctx.auditWriter?.write(
        FILE_TOOL_AUDIT_EVENTS.INPUT_VALIDATION_FAILED,
        `tool=write`,
        `error=${formatErr(err)}`,
      );
      return {
        success: false,
        content: `write tool input validation failed: ${(err as Error).message}`,
      };
    }

    const { path: filePath, content, append: appendArg } = args;
    const append = appendArg === true;

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

    // overwrite gate — phase 1430 hash + mtime + isFullRead, granular reason since phase 1457 followup
    if (!append) {
      const exists = await ctx.fs.exists(resolved);
      if (exists) {
        const gate = await enforceFullReadGate(ctx, resolved, filePath);
        if (!gate.ok) {
          // phase 695: 拆 path + reason 为两 col、与 phase 690-694 同模式
          ctx.auditWriter?.write(
            FILE_TOOL_AUDIT_EVENTS.OVERWRITE_GATE_REJECTED,
            `path=${resolved}`,
            `reason=${gate.reason}`,
          );
          return {
            success: false,
            content: gate.result.content + ` For files where the response would exceed 100 KB, use edit/multi_edit, or write with append:true.`,
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
        // overwrite 写成功 → 更新 readFileState（写入的就是新全文、isFullRead=true）
        const newStat = await ctx.fs.stat(resolved);
        recordWriteResult(ctx, resolved, content, newStat.mtime.getTime());
      }

      const backupHint = backupPath ? ` (backup: ${backupPath})` : '';
      return { success: true, content: `Written: ${filePath} (${content.length} chars)${backupHint}` };
    } catch (error) {
      return {
        success: false,
        content: `Error writing file: ${formatErr(error)}`,
      };
    }
  },
};
