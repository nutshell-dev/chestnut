/**
 * @module L2.FileTool
 * write tool - Write or append to file
 *
 * Features (MVP aligned):
 * - Auto-backups to clawDir/tasks/sync/ (turn-scoped / cleaned by Snapshot commit)
 * - Overwrite gate: file must be fully read in this session first (phase 487 G6)
 */

import * as path from 'path';
import type { Tool, ToolResult, ExecContext } from '../tool-protocol/index.js';
import { getChecker } from './permission-context.js';
import { backupToSync } from './sync-backup.js';

import { WRITE_TOOL_NAME } from '../tools/tool-names.js';
export { WRITE_TOOL_NAME };

export const writeTool: Tool = {
  name: WRITE_TOOL_NAME,
  description: 'Write content to a file. Use append=true to append instead of overwrite. Auto-backups to clawDir/tasks/sync/ (turn-scoped / cleaned by Snapshot commit). For overwrite mode (append=false), file must be fully read in this session first (read without truncation). WARNING: single LLM output is limited to ~4096 tokens (~3000 chars). For long files, split into multiple write calls: first call without append, subsequent calls with append=true.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to write',
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
    const content = args.content as string;
    const append = args.append === true;

    // Phase430: claw-space boundary check — caller autonomy
    const checker = getChecker(ctx.clawDir);
    checker.resolveAndCheck(filePath, 'write');

    // overwrite gate (phase 487 G6 (a) / append 不 gate)
    if (!append) {
      const exists = await ctx.fs.exists(filePath);
      if (exists && !ctx.fullyReadPaths.has(filePath)) {
        return {
          success: false,
          content: `Error: 'overwrite' mode requires fully-read first. Path '${filePath}' was not fully read in this session. Use append=true, or read the file first (without truncation).`,
        };
      }
    }

    try {
      let backupPath: string | null = null;
      if (!append) {
        backupPath = await backupToSync(ctx, filePath, 'file_backup');
      }

      if (append) {
        await ctx.fs.append(filePath, content);
      } else {
        await ctx.fs.writeAtomic(filePath, content);
        // overwrite 写成功时 add fullyReadPaths (append 不 add)
        ctx.fullyReadPaths.add(filePath);
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
