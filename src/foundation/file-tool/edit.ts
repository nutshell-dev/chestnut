/**
 * @module L2.FileTool
 * edit tool - Replace exact string in a file
 *
 * Features:
 * - Unique match by default (multiple matches reject unless replace_all=true)
 * - 0 match fail loud with hint
 * - Backup to syncDir with frontmatter
 * - Atomic write (temp+rename)
 * - File must exist (use write to create)
 */

import type { Tool, ToolResult, ExecContext } from '../tool-protocol/index.js';
import { getChecker } from './permission-context.js';
import { backupToSync } from './sync-backup.js';
import { EDIT_TOOL_NAME } from '../tools/tool-names.js';
export { EDIT_TOOL_NAME };

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
  description: 'Replace exact string in a file (for subagent partial modify). old_string must uniquely match by default; use replace_all=true for batch. File must exist.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'Exact string to replace (must uniquely match by default)',
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
    required: ['path', 'old_string', 'new_string'],
  },
  readonly: false,
  idempotent: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = args.replace_all === true;

    // Phase430: claw-space boundary check — caller autonomy
    const checker = getChecker(ctx.clawDir);
    checker.resolveAndCheck(filePath, 'write');

    // File must exist
    const exists = await ctx.fs.exists(filePath);
    if (!exists) {
      return {
        success: false,
        content: `Error: File '${filePath}' does not exist (use write to create)`,
      };
    }

    const content = await ctx.fs.read(filePath);

    // Match checking
    const matches = countMatches(content, oldString);
    if (matches === 0) {
      return {
        success: false,
        content: `Error: 0 matches for old_string in '${filePath}' (G4 fail loud / check exact string including whitespace / newlines / indentation)`,
      };
    }
    if (matches > 1 && !replaceAll) {
      return {
        success: false,
        content: `Error: ${matches} matches for old_string in '${filePath}' (G4 fail loud / expand old_string with more context to make it unique / or use replace_all=true for explicit batch)`,
      };
    }

    // Backup
    const backupPath = await backupToSync(ctx, filePath, 'edit_backup');

    // Replace
    const replaced = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    await ctx.fs.writeAtomic(filePath, replaced);

    const replacedCount = replaceAll ? matches : 1;
    const backupHint = backupPath ? ` (backup: ${backupPath})` : '';
    return {
      success: true,
      content: `Edited: ${filePath} (replaced ${replacedCount}/${matches} matches)${backupHint}`,
      metadata: { replaced: replacedCount },
    };
  },
};
