/**
 * @module L2.FileTool
 * edit tool - Replace exact string in a file
 *
 * Features:
 * - Unique match by default (multiple matches reject unless replaceAll=true)
 * - 0 match fail loud with hint (verify with `read`)
 * - Backup to syncDir with frontmatter
 * - Atomic write (temp+rename)
 * - File must exist (use write to create)
 * - Success returns ±3-line context diff (formatEditDiff)
 */

import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';

import { backupToSync } from './sync-backup.js';
import { resolveWorkspacePath } from './resolve-path.js';
import { recordEditResult } from './file-state-manager.js';
import { enforceFullReadGate } from './fullread-gate.js';
import { formatEditDiff, lineDelta, findNearMatches, findAllMatchLines } from './edit-format.js';
export const EDIT_TOOL_NAME = 'edit' as const;

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

export const editTool: Tool = {
  name: EDIT_TOOL_NAME,
  profiles: ['full', 'subagent', 'miner'],
  group: 'fs-write',
  description: 'Edit a file by exact string replace. Path resolves against your clawspace; use "../" to access claw root (e.g. "../MEMORY.md"). oldText must uniquely match by default; set replaceAll=true for batch. File must exist (use write to create).',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (workspace-relative, "../" allowed for claw root access)',
      },
      oldText: {
        type: 'string',
        description: 'Exact text to replace (must uniquely match by default; preserve whitespace / newlines / indentation literally)',
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
    required: ['path', 'oldText', 'newText'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const oldText = args.oldText as string;
    const newText = args.newText as string;
    const replaceAll = args.replaceAll === true;

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
      throw new Error('FileTool.edit: ctx.permissionChecker not injected (Assembly should inject via createClawPermissionChecker)');
    }
    checker.resolveAndCheck(resolved, 'write');

    // phase 1456 P4: empty oldText is structurally invalid (would match nothing in a
    // useful way). Reject explicitly rather than silently failing with "0 matches".
    if (typeof oldText !== 'string' || oldText.length === 0) {
      return {
        success: false,
        content: `Error: oldText must be a non-empty string for edit on '${filePath}'.`,
      };
    }
    // phase 1456 P3: no-op edit (oldText === newText) consumes IO + bumps mtime + may
    // refresh readFileState — violates DP「不丢弃/静默」. Reject + tell agent to skip.
    if (oldText === newText) {
      return {
        success: false,
        content: `Error: oldText === newText (no-op edit on '${filePath}'). Skip this edit or set newText to the intended replacement.`,
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

    const content = await ctx.fs.read(resolved);

    // Match checking
    const matches = countMatches(content, oldText);
    if (matches === 0) {
      // phase 1456 P1: attach near-miss hint so agent knows where to look
      const nearMatches = findNearMatches(content, oldText);
      const nearHint = nearMatches.length > 0
        ? '\n\nNear matches (line: text):\n' + nearMatches.map(m => `  ${m.line} (${m.score}): ${m.text}`).join('\n')
        : '';
      return {
        success: false,
        content: `Error: 0 matches for oldText in '${filePath}'. Verify current content with \`read\` (the file may have changed since your last read) and ensure whitespace / newlines / indentation match literally.${nearHint}`,
      };
    }
    if (matches > 1 && !replaceAll) {
      // phase 1456 P2: attach match line list so agent can pick which to expand
      const lines = findAllMatchLines(content, oldText, 5);
      const lineList = lines.join(', ') + (matches > 5 ? `, +${matches - 5} more` : '');
      return {
        success: false,
        content: `Error: ${matches} matches for oldText in '${filePath}' (at lines: ${lineList}). Expand oldText with surrounding context to make it unique, or set replaceAll=true for explicit batch. Use \`read\` to confirm current content if unsure.`,
      };
    }

    // phase 1447: replaceAll is bulk-destructive (rewrites every match including
    // contexts the agent may never have seen) → same gate as write overwrite.
    if (replaceAll) {
      const gateError = await enforceFullReadGate(ctx, resolved, filePath);
      if (gateError) {
        return {
          success: false,
          content: gateError.content + ` This is required because replaceAll=true rewrites every match, including contexts you may not have seen. Alternatively, set replaceAll=false with a uniquely-matching oldText to scope the change.`,
        };
      }
    }

    // Backup
    const backupPath = await backupToSync(ctx, resolved, 'edit_backup');

    // Replace
    const replaced = replaceAll
      ? content.split(oldText).join(newText)
      : content.replace(oldText, newText);

    await ctx.fs.writeAtomic(resolved, replaced);
    // phase 1437: 不升 isFullRead=true、保 prevState（edit 内部 read 全文是私事）。
    // phase 1439 V3: 语义封装到 recordEditResult、本处仅调用、不再复制 prev-state-inheritance 规则。
    const newStat = await ctx.fs.stat(resolved);
    recordEditResult(ctx, resolved, replaced, newStat.mtime.getTime());

    const replacedCount = replaceAll ? matches : 1;
    const backupHint = backupPath ? ` (backup: ${backupPath})` : '';
    const delta = lineDelta(oldText, newText) * replacedCount;
    const deltaHint = delta === 0 ? '' : ` / line delta ${delta >= 0 ? '+' : ''}${delta}`;
    const diff = formatEditDiff(content, oldText, newText);
    const moreHint = replaceAll && matches > 1
      ? `\n(${matches - 1} more replacement${matches - 1 === 1 ? '' : 's'} elsewhere; preview shows first)`
      : '';
    return {
      success: true,
      content: `Edited: ${filePath} (replaced ${replacedCount}/${matches} matches${deltaHint})${backupHint}\n\n${diff}${moreHint}`,
      metadata: { replaced: replacedCount },
    };
  },
};
