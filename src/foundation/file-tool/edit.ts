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

import { z } from 'zod';
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import { formatErr } from '../utils/index.js';

import { backupToSync } from './sync-backup.js';
import { resolveWorkspacePath } from './resolve-path.js';
import { recordEditResult } from './file-state-manager.js';
import { enforceFullReadGate } from './fullread-gate.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';
import { defineFileToolSchema } from './_zod-helper.js';
import { formatEditDiff, lineDelta, findNearMatches, findAllMatchLines } from './edit-text-utils.js';
export const EDIT_TOOL_NAME = 'edit' as const;

const EditInputSchema = z.object({
  path: z.string().describe(
    'File path (workspace-relative, "../" allowed for claw root access)'
  ),
  oldText: z.string().describe(
    'Exact text to replace (must uniquely match by default; preserve whitespace / newlines / indentation literally)'
  ),
  newText: z.string().describe('Replacement text (empty string deletes the matched range)'),
  replaceAll: z.boolean().optional().describe(
    'If true, replace all occurrences instead of just the first'
  ),
}).strict();

type EditInput = z.infer<typeof EditInputSchema>;

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
  schema: defineFileToolSchema(EditInputSchema),
  readonly: false,
  idempotent: false,

  async execute(rawArgs: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    let args: EditInput;
    try {
      args = EditInputSchema.parse(rawArgs);
    } catch (err) {
      // phase 692: 拆 tool + error 为两 col、与 phase 690/691 同模式
      ctx.auditWriter?.write(
        FILE_TOOL_AUDIT_EVENTS.INPUT_VALIDATION_FAILED,
        `tool=edit`,
        `error=${formatErr(err)}`,
      );
      return {
        success: false,
        content: `edit tool input validation failed: ${(err as Error).message}`,
      };
    }

    const { path: filePath, oldText, newText, replaceAll } = args;

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

    // phase 517 B4: 记 read 时 mtime、write 前再验、外部改动则拒绝（防 silent 覆盖外部 edit）
    const statBeforeRead = await ctx.fs.stat(resolved);
    const mtimeAtRead = statBeforeRead.mtime.getTime();
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
      const gate = await enforceFullReadGate(ctx, resolved, filePath);
      if (!gate.ok) {
        return {
          success: false,
          content: gate.result.content + ` This is required because replaceAll=true rewrites every match, including contexts you may not have seen. Alternatively, set replaceAll=false with a uniquely-matching oldText to scope the change.`,
        };
      }
    }

    // phase 517 B4: write 前再 stat 验 mtime、外部进程在 T1-T2 间写文件则拒绝、agent 重读后重试
    // 接受 mtime 精度漏（同毫秒内连续 read+write 可能漏检、攻击/race 窗口太短不实用）
    const statBeforeWrite = await ctx.fs.stat(resolved);
    if (statBeforeWrite.mtime.getTime() !== mtimeAtRead) {
      return {
        success: false,
        content: `Error: File '${filePath}' was modified externally between read and write (mtime changed). Re-read the file with \`read\` and retry the edit with current content.`,
      };
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
