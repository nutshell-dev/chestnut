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
import { computeContentHash } from './file-state.js';
import { enforceFullReadGate } from './fullread-gate.js';
import { formatEditDiff, lineDelta } from './edit-format.js';
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
      return {
        success: false,
        content: `Error: 0 matches for oldText in '${filePath}'. Verify current content with \`read\` (the file may have changed since your last read) and ensure whitespace / newlines / indentation match literally.`,
      };
    }
    if (matches > 1 && !replaceAll) {
      return {
        success: false,
        content: `Error: ${matches} matches for oldText in '${filePath}'. Expand oldText with surrounding context to make it unique, or set replaceAll=true for explicit batch. Use \`read\` to confirm current content if unsure.`,
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
    // phase 1437: 不能 unconditionally 升 isFullRead=true。
    // edit 工具内部 ctx.fs.read 读全文是私事，claw 只显式知道 old_string→new_string 一处替换。
    // 只有 claw 此前真通过 read 工具看过全文（prevState.isFullRead===true），edit 后才仍算"看过全文"
    // （claw 可基于旧全文 + 自己 commit 的 edit 推算新全文）。否则保持 false。
    const prevState = ctx.readFileState.get(resolved);
    const newStat = await ctx.fs.stat(resolved);
    ctx.readFileState.set(resolved, {
      hash: computeContentHash(replaced),
      timestamp: newStat.mtime.getTime(),
      isFullRead: prevState?.isFullRead ?? false,
    });

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
