/**
 * @module L2c.FileTool
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
import { formatErr } from '../node-utils/index.js';

import { resolveWorkspacePath } from './resolve-path.js';
import { enforceFullReadGate } from './fullread-gate.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';
import { defineFileToolSchema } from './_zod-helper.js';
import { formatEditDiff, lineDelta, findNearMatches, findAllMatchLines } from './edit-text-utils.js';
import { literalReplace } from './literal-replace.js';
import { editCommit } from './edit-commit.js';
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

export const editTool: Tool = {
  name: EDIT_TOOL_NAME,
  profiles: ['full', 'subagent', 'miner'],
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

    // Read original content (phase 1109 Step C: conflict detection moves to editCommit via hash)
    const content = await ctx.fs.read(resolved);

    // Match checking (phase 1109 Step B: literal replacement primitive)
    const replaceResult = literalReplace(content, oldText, newText, replaceAll ? 'all' : 'unique');
    if (!replaceResult.ok) {
      if (replaceResult.reason === 'not-found') {
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
      // replaceResult.reason === 'multiple-matches'
      // phase 1456 P2: attach match line list so agent can pick which to expand
      const matches = replaceResult.matches;
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

    // phase 1109 Step C: commit through shared coordinator
    const replacedCount = replaceResult.replaced;
    const commitResult = await editCommit({
      ctx,
      tool: 'edit',
      path: filePath,
      resolved,
      original: content,
      candidate: replaceResult.content,
      backupSource: 'edit_backup',
      replaced: replacedCount,
      editCount: 1,
    });

    if (!commitResult.ok) {
      return {
        success: false,
        content: commitResult.content,
      };
    }

    const backupHint = commitResult.backupPath ? ` (backup: ${commitResult.backupPath})` : '';
    const delta = lineDelta(oldText, newText) * replacedCount;
    const deltaHint = delta === 0 ? '' : ` / line delta ${delta >= 0 ? '+' : ''}${delta}`;
    const diff = formatEditDiff(content, oldText, newText);
    const moreHint = replaceAll && replaceResult.matches > 1
      ? `\n(${replaceResult.matches - 1} more replacement${replaceResult.matches - 1 === 1 ? '' : 's'} elsewhere; preview shows first)`
      : '';
    return {
      success: true,
      content: `Edited: ${filePath} (replaced ${replacedCount}/${replaceResult.matches} matches${deltaHint})${backupHint}\n\n${diff}${moreHint}`,
      metadata: { replaced: replacedCount },
    };
  },
};
