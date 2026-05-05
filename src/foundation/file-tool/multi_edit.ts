/**
 * @module L2.FileTool
 * multi_edit tool - Apply multiple edits to a file atomically
 *
 * Features:
 * - Edits applied in order in-memory
 * - Any failure aborts all edits + 0 fs write (rollback)
 * - Single backup before all edits
 * - Atomic write on success (single writeAtomic)
 * - File must exist
 */

import type { Tool, ToolResult, ExecContext } from '../tool-protocol/index.js';
import { getChecker } from './permission-context.js';
import { backupToSync } from './sync-backup.js';
import { MULTI_EDIT_TOOL_NAME } from '../tools/tool-names.js';
export { MULTI_EDIT_TOOL_NAME };

function countMatches(s: string, pattern: string): number {
  if (!pattern) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = s.indexOf(pattern, pos)) !== -1) {
    count++;
    pos += pattern.length;
  }
  return count;
}

export const multiEditTool: Tool = {
  name: MULTI_EDIT_TOOL_NAME,
  description: 'Apply multiple edits to a file atomically. Edits are applied in order; on any failure, all edits are rolled back. Single backup before all edits. File must exist.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit',
      },
      edits: {
        type: 'array',
        description: 'Array of edits to apply in order',
        items: {
          type: 'object',
          properties: {
            old_string: {
              type: 'string',
              description: 'Exact string to replace',
            },
            new_string: {
              type: 'string',
              description: 'Replacement string',
            },
            replace_all: {
              type: 'boolean',
              description: 'If true, replace all occurrences instead of just the first',
            },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const edits = args.edits as Array<{ old_string: string; new_string: string; replace_all?: boolean }>;

    // Phase430: claw-space boundary check — caller autonomy
    const checker = getChecker(ctx.clawDir);
    checker.resolveAndCheck(filePath, 'write');

    // Edits array must not be empty
    if (!edits || edits.length === 0) {
      return {
        success: false,
        content: `Error: edits array must contain at least 1 edit (G4 fail loud)`,
      };
    }

    // File must exist
    const exists = await ctx.fs.exists(filePath);
    if (!exists) {
      return {
        success: false,
        content: `Error: File '${filePath}' does not exist (use write to create)`,
      };
    }

    const original = await ctx.fs.read(filePath);

    // Single backup before applying edits
    const backupPath = await backupToSync(ctx, filePath, 'multi_edit_backup');

    // Apply edits in-memory
    let current = original;
    const results: Array<{ index: number; replaced: number }> = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const matches = countMatches(current, edit.old_string);
      if (matches === 0) {
        return {
          success: false,
          content: `Error: edit[${i}] 0 matches for old_string (G3 hint: fix the first failed edit and retry / subsequent edits may be invalidated / all changes rolled back / 0 file writes)`,
          metadata: { failed_index: i, results },
        };
      }
      if (matches > 1 && !edit.replace_all) {
        return {
          success: false,
          content: `Error: edit[${i}] ${matches} matches (expand old_string or use replace_all=true / G3 hint: fix the first failed edit and retry / all changes rolled back)`,
          metadata: { failed_index: i, results },
        };
      }
      current = edit.replace_all
        ? current.split(edit.old_string).join(edit.new_string)
        : current.replace(edit.old_string, edit.new_string);
      results.push({ index: i, replaced: edit.replace_all ? matches : 1 });
    }

    // All edits succeeded — single atomic write
    await ctx.fs.writeAtomic(filePath, current);

    const backupHint = backupPath ? ` (backup: ${backupPath})` : '';
    return {
      success: true,
      content: `Multi-edited: ${filePath} (${edits.length} edits applied)${backupHint}`,
      metadata: { results },
    };
  },
};
