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
 * - Success returns Applied summary + First edit preview (formatEditDiff)
 */

import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';

import { backupToSync } from './sync-backup.js';
import { resolveWorkspacePath } from './resolve-path.js';
import { recordEditResult } from './file-state-manager.js';
import { findFirstMatchLine, formatEditDiff, lineDelta } from './edit-format.js';
export const MULTI_EDIT_TOOL_NAME = 'multi_edit' as const;

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
  profiles: ['full', 'subagent', 'miner'],
  group: 'fs-write',
  description: 'Apply multiple sequential edits to a file atomically. Path resolves against your clawspace; use "../" to access claw root. Edits apply in order; any failure rolls all back (0 fs write). Single backup before all edits. File must exist.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (workspace-relative, "../" allowed for claw root access)',
      },
      edits: {
        type: 'array',
        description: 'Array of edits to apply in order. Each edit takes oldText (exact match) + newText, optional replaceAll. Note: edits[i].oldText must match the file AFTER edits[0..i-1] have been applied — order-sensitive.',
        items: {
          type: 'object',
          properties: {
            oldText: {
              type: 'string',
              description: 'Exact text to replace',
            },
            newText: {
              type: 'string',
              description: 'Replacement text (empty string deletes the matched range)',
            },
            replaceAll: {
              type: 'boolean',
              description: 'If true, replace all occurrences instead of just the first',
            },
          },
          required: ['oldText', 'newText'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const edits = args.edits as Array<{ oldText: string; newText: string; replaceAll?: boolean }>;

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
      throw new Error('FileTool.multi_edit: ctx.permissionChecker not injected (Assembly should inject via createClawPermissionChecker)');
    }
    checker.resolveAndCheck(resolved, 'write');

    // Edits array must not be empty
    if (!edits || edits.length === 0) {
      return {
        success: false,
        content: `Error: edits array must contain at least 1 edit`,
      };
    }

    // File must exist
    const exists = await ctx.fs.exists(resolved);
    if (!exists) {
      return {
        success: false,
        content: `Error: File '${filePath}' does not exist (use write to create)`,
      };
    }

    const original = await ctx.fs.read(resolved);

    // Single backup before applying edits
    const backupPath = await backupToSync(ctx, resolved, 'multi_edit_backup');

    // Apply edits in-memory
    let current = original;
    const results: Array<{ index: number; replaced: number; line: number | null }> = [];
    let firstEditPreview = '';

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const matches = countMatches(current, edit.oldText);
      if (matches === 0) {
        return {
          success: false,
          content: `Error: edit[${i}] 0 matches for oldText. All changes rolled back / 0 file writes. Verify current content with \`read\` (the file may have changed) — also note: edits[${i}].oldText must match the file AFTER edits[0..${i - 1}] have been applied, so an earlier edit may have invalidated this one.`,
          metadata: { failed_index: i, results },
        };
      }
      if (matches > 1 && !edit.replaceAll) {
        return {
          success: false,
          content: `Error: edit[${i}] ${matches} matches. Expand oldText with surrounding context or set replaceAll=true. All changes rolled back / 0 file writes. Use \`read\` to confirm current content if unsure.`,
          metadata: { failed_index: i, results },
        };
      }
      const matchLine = findFirstMatchLine(current, edit.oldText);
      if (i === 0) {
        firstEditPreview = formatEditDiff(current, edit.oldText, edit.newText);
      }
      current = edit.replaceAll
        ? current.split(edit.oldText).join(edit.newText)
        : current.replace(edit.oldText, edit.newText);
      results.push({ index: i, replaced: edit.replaceAll ? matches : 1, line: matchLine });
    }

    // All edits succeeded — single atomic write
    await ctx.fs.writeAtomic(resolved, current);
    // phase 1437: 不升 isFullRead=true、保 prevState。phase 1439 V3: 语义封装到 recordEditResult。
    const newStat = await ctx.fs.stat(resolved);
    recordEditResult(ctx, resolved, current, newStat.mtime.getTime());

    const backupHint = backupPath ? ` (backup: ${backupPath})` : '';
    const totalDelta = edits.reduce(
      (sum, e, i) => sum + lineDelta(e.oldText, e.newText) * results[i].replaced,
      0,
    );
    const deltaHint = totalDelta === 0 ? '' : ` / line delta ${totalDelta >= 0 ? '+' : ''}${totalDelta}`;
    const summary = results
      .map(r => `  edit[${r.index}]: ${r.line !== null ? `at line ${r.line}` : '(in-edit chain)'} / replaced ${r.replaced}`)
      .join('\n');
    const previewBlock = firstEditPreview ? `\n\nFirst edit preview:\n${firstEditPreview}` : '';
    const moreHint = edits.length > 1 ? `\n(${edits.length - 1} more edit${edits.length - 1 === 1 ? '' : 's'} applied; preview shows edits[0])` : '';
    return {
      success: true,
      content: `Multi-edited: ${filePath} (${edits.length} edits applied${deltaHint})${backupHint}\n\nApplied:\n${summary}${previewBlock}${moreHint}`,
      metadata: { results },
    };
  },
};
