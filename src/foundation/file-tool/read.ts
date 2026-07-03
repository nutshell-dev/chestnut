/**
 * @module L2c.FileTool
 * read tool - Read file contents.
 *
 * phase 1430 cap model:
 *   - `READ_DEFAULT_LINES = 200` applies when caller does NOT pass `limit`; `offset` alone still triggers the cap (from `offset`).
 *   - `READ_OUTPUT_HARD_CAP_BYTES = 100 KB` applies regardless: above it, head+tail returned and full content persists to `tasks/sync/read/<id>.md` (mirrors exec_overflow).
 *   - `readFileState` Map entry written only for same-claw reads.
 *   - `isFullRead: true` iff this read covered every current line of the file
 *     (start at line 1 AND limit window reaches totalLines) AND output not byte-cap truncated.
 *     phase 1444 reframe: explicit `limit >= totalLines` reads also qualify (was previously
 *     "no offset/limit at all" — the 200-line cliff banned overwrite of larger files).
 *
 * phase 305: Zod schema 作为 SoT，JSON schema / TypeScript type 均 derive；strict mode
 * 在 runtime 拒绝含 cwd 等未声明字段的输入。
 */

import * as nodePath from 'path';
import { newShortUuid } from  '../node-utils/index.js';
import { z } from 'zod';
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import {
  READ_DEFAULT_LINES,
  READ_OUTPUT_HARD_CAP_BYTES,
  TASKS_SYNC_READ_DIR,
} from './constants.js';

import { resolveWorkspacePath } from './resolve-path.js';
import { formatErr } from '../node-utils/index.js';
import { truncateHeadTail } from './truncate-head-tail.js';
import { recordReadResult } from './file-state-manager.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';
import { defineFileToolSchema } from './_zod-helper.js';


function toSafeNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) || !Number.isFinite(n) ? undefined : n;
}

export const READ_TOOL_NAME = 'read' as const;

const ReadInputSchema = z.object({
  path: z.string().describe(
    'File path (workspace-relative, "../" allowed for claw root access)'
  ),
  offset: z.number().optional().describe(
    'Starting line number (1-indexed). Negative counts from end of file (-10 = 10 lines before end).'
  ),
  limit: z.number().optional().describe(
    'Maximum lines to read. When set, overrides the 200-line default. Output still subject to the 100 KB byte cap.'
  ),
}).strict();

type ReadInput = z.infer<typeof ReadInputSchema>;

// phase 524: HEAD/TAIL 常量 + truncateHeadTail 抽 foundation/file-tool/truncate-head-tail.ts、
// 与 command-tool/exec.ts 共享同一业务 truncation 协议。

async function persistOverflow(ctx: ExecContext, output: string): Promise<string | null> {
  try {
    const id = newShortUuid();
    const fullPath = nodePath.join(ctx.syncDir, TASKS_SYNC_READ_DIR.split('/').pop()!, `${id}.md`);
    const frontmatter = `---\nsource: read_overflow\ncontent_length: ${output.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + output);
    return nodePath.relative(ctx.workspaceDir, fullPath);
  } catch (err) {
    ctx.auditWriter?.write(FILE_TOOL_AUDIT_EVENTS.READ_OVERFLOW_PERSIST_FAILED, `reason=${formatErr(err)}`);
    return null;
  }
}

export const readTool: Tool = {
  name: READ_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  description: [
    'Reads a file. Path resolves against your clawspace; use "../" to access claw root (e.g. "../MEMORY.md").',
    '',
    'Default (no offset/limit): up to the first 200 lines.',
    '',
    'With limit set: up to `limit` lines starting from `offset` (defaults to line 1). Setting only `offset` keeps a 200-line window from `offset`.',
    '',
    'If the response would exceed 100 KB: only the head and tail are returned, the full content is saved to disk, and the saved path is in the response. Read that saved path with offset/limit to view ranges of it.',
    '',
    'Overwrite via `write` is rejected unless this read covered every current line of the file (start at line 1 with limit >= totalLines, no byte-cap truncation) and the file is unchanged since. For files where one read can\'t cover everything (>100 KB output), modify via `edit`/`multi_edit` (range-based, no full-read requirement) or use `write` with `append: true` (bypasses the gate).',
  ].join('\n'),
  schema: defineFileToolSchema(ReadInputSchema),
  readonly: true,
  idempotent: true,

  async execute(rawArgs: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    let args: ReadInput;
    try {
      args = ReadInputSchema.parse(rawArgs);
    } catch (err) {
      // phase 692: 拆 tool + error 为两 col、与 phase 690/691 同模式
      ctx.auditWriter?.write(
        FILE_TOOL_AUDIT_EVENTS.INPUT_VALIDATION_FAILED,
        `tool=read`,
        `error=${formatErr(err)}`,
      );
      return {
        success: false,
        content: `read tool input validation failed: ${(err as Error).message}`,
      };
    }

    const { path: filePath } = args;
    const offset = toSafeNumber(args.offset);
    const limit = toSafeNumber(args.limit);

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
      throw new Error('FileTool.read: ctx.permissionChecker not injected (Assembly should inject via createClawPermissionChecker)');
    }
    checker.resolveAndCheck(resolved, 'read');

    try {
      const rawContent = await ctx.fs.read(resolved);

      // Capture full file content for hash + future FileState write before slicing mutates it.
      const fullFileContent = rawContent;

      // Stat for mtime (used in FileState)
      let fileMtime: number | undefined;
      try {
        const stat = await ctx.fs.stat(resolved);
        fileMtime = stat.mtime.getTime();
      } catch {
        // silent: stat failure here means FileState cannot be written for this read;
        // downstream gate will reject overwrite (no isFullRead=true entry) — fail-safe.
      }

      const totalLines = fullFileContent.split('\n').length;

      // Compute start (1-indexed; negative counts from end)
      let start: number;
      if (offset !== undefined) {
        start = offset - 1;
        if (start < 0) start = Math.max(0, totalLines + start + 1);
      } else {
        start = 0;
      }

      // Compute end and detect line cap
      // limit set → caller decides; limit unset → READ_DEFAULT_LINES applies from `start`
      let end: number;
      let lineCapTriggered = false;
      if (limit !== undefined) {
        end = start + limit;
      } else {
        end = start + READ_DEFAULT_LINES;
        lineCapTriggered = (totalLines - start) > READ_DEFAULT_LINES;
      }

      const fileLines = fullFileContent.split('\n');
      let content = fileLines.slice(start, end).join('\n');

      // Line cap meta (appended only when truncation happened)
      if (lineCapTriggered) {
        const showingTo = Math.min(end, totalLines);
        content += `\n[Showing lines ${start + 1}-${showingTo} of ${totalLines}. Pass \`limit\` to read more.]`;
      }

      // Byte cap: persist overflow + head/tail preview (resource safety, independent of line cap)
      let byteCapTriggered = false;
      if (content.length > READ_OUTPUT_HARD_CAP_BYTES) {
        byteCapTriggered = true;
        const relPath = await persistOverflow(ctx, content);
        content = relPath
          ? truncateHeadTail(content, relPath)
          : content.slice(0, READ_OUTPUT_HARD_CAP_BYTES) + '\n[truncated - overflow persist failed]';
      }

      // readFileState write — same-claw only
      if (fileMtime !== undefined) {
        // phase 1444: isFullRead = "this read covered every current line of the file".
        // Decoupled from rangeRequested — an explicit `limit >= totalLines` read also counts.
        // (Removes the 200-line cliff that effectively banned overwrite of larger files.)
        const sawAllLines = start === 0 && end >= totalLines;
        const isFullRead = sawAllLines && !byteCapTriggered;
        recordReadResult(ctx, resolved, fullFileContent, fileMtime, isFullRead);
      }

      return {
        success: true,
        content,
      };
    } catch (error) {
      return {
        success: false,
        content: `Error reading file: ${formatErr(error)}`,
      };
    }
  },
};
