/**
 * @module L2.FileTool
 * read tool - Read file contents.
 *
 * Cross-claw access: `claw: "<id>"` targets another claw (read/ls do NOT implement `"*"` broadcast — only search does).
 *
 * phase 1430 cap model:
 *   - `READ_DEFAULT_LINES = 200` applies when caller does NOT pass `limit`; `offset` alone still triggers the cap (from `offset`).
 *   - `READ_OUTPUT_HARD_CAP_BYTES = 100 KB` applies regardless: above it, head+tail returned and full content persists to `tasks/sync/read/<id>.md` (mirrors exec_overflow).
 *   - `readFileState` Map entry written only for same-claw reads.
 *   - `isFullRead: true` iff this read covered every current line of the file
 *     (start at line 1 AND limit window reaches totalLines) AND output not byte-cap truncated.
 *     phase 1444 reframe: explicit `limit >= totalLines` reads also qualify (was previously
 *     "no offset/limit at all" — the 200-line cliff banned overwrite of larger files).
 */

import * as nodePath from 'path';
import { randomUUID } from 'crypto';
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import {
  READ_DEFAULT_LINES,
  READ_OUTPUT_HARD_CAP_BYTES,
  TASKS_SYNC_READ_DIR,
} from './constants.js';

import { resolveWorkspacePath } from './resolve-path.js';
import { safeNumber, formatErr } from '../utils/index.js';
import { computeContentHash } from './file-state.js';

import { CLAWS_DIR, CLAWSPACE_DIR } from '../paths.js';
import { UUID_SHORT_LEN } from '../../constants.js';

export const READ_TOOL_NAME = 'read' as const;

const HEAD_LIMIT = 600;
const TAIL_LIMIT = 1400;

function truncateHeadTail(content: string, relPath: string): string {
  const head = content.slice(0, HEAD_LIMIT);
  const tail = content.slice(-TAIL_LIMIT);
  const truncatedBytes = content.length - HEAD_LIMIT - TAIL_LIMIT;
  return `${head}\n[...truncated ${truncatedBytes} bytes...]\n${tail}\nFull output (${content.length} bytes) saved. Use \`read\` with offset/limit to view ranges (read is capped per call, paginate by offset):\n  read: { "path": "${relPath}", "offset": 1, "limit": 200 }`;
}

async function persistOverflow(ctx: ExecContext, output: string): Promise<string | null> {
  try {
    const id = randomUUID().slice(0, UUID_SHORT_LEN);
    const fullPath = nodePath.join(ctx.syncDir, TASKS_SYNC_READ_DIR.split('/').pop()!, `${id}.md`);
    const frontmatter = `---\nsource: read_overflow\ncontent_length: ${output.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + output);
    return nodePath.relative(ctx.workspaceDir, fullPath);
  } catch (err) {
    ctx.auditWriter?.write('read_overflow_persist_failed', `reason=${formatErr(err)}`);
    return null;
  }
}

export const readTool: Tool = {
  name: READ_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  group: 'fs-read',
  description: [
    'Reads a file. Path resolves against your clawspace; use "../" to access claw root (e.g. "../MEMORY.md"). Pass `claw: "<id>"` to read another claw\'s file.',
    '',
    'Default (no offset/limit): up to the first 200 lines.',
    '',
    'With limit set: up to `limit` lines starting from `offset` (defaults to line 1). Setting only `offset` keeps a 200-line window from `offset`.',
    '',
    'If the response would exceed 100 KB: only the head and tail are returned, the full content is saved to disk, and the saved path is in the response. Read that saved path with offset/limit to view ranges of it.',
    '',
    'Overwrite via `write` is rejected unless this read covered every current line of the file (start at line 1 with limit >= totalLines, no byte-cap truncation) and the file is unchanged since. For files where one read can\'t cover everything (>100 KB output), modify via `edit`/`multi_edit` (range-based, no full-read requirement) or use `write` with `append: true` (bypasses the gate).',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (workspace-relative, "../" allowed for claw root access)',
      },
      offset: {
        type: 'number',
        description: 'Starting line number (1-indexed). Negative counts from end of file (-10 = 10 lines before end).',
      },
      limit: {
        type: 'number',
        description: 'Maximum lines to read. When set, overrides the 200-line default. Output still subject to the 100 KB byte cap.',
      },
      claw: {
        type: 'string',
        description: 'Target claw ID. e.g. { "path": "contract/xxx/progress.json", "claw": "claw1" }',
      },
    },
    required: ['path'],
  },
  readonly: true,
  idempotent: true,
  supportsAsync: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const offset = safeNumber(args.offset);
    const limit = safeNumber(args.limit);
    const clawParam = args.claw as string | undefined;

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

    // Cross-claw read: specific target / 任意 callerType OK（D11 inter-claw 互访 align）
    let content: string;
    if (clawParam !== undefined) {
      if (!ctx.fsFactory) {
        return {
          success: false,
          content: 'Error: Cross-claw access not available in this context (fsFactory not injected)',
        };
      }
      // Reject '*' explicitly — read does not implement broadcast (only search does).
      // Without this, '*' silently falls through to ENOENT on <clawsDir>/*/clawspace.
      if (clawParam === '*') {
        return {
          success: false,
          content: 'Error: claw: "*" broadcast is not supported by read (only search supports it).',
        };
      }
      // Validate clawParam (no path traversal)
      if (clawParam.includes('/') || clawParam.includes('..') || clawParam === '' || clawParam === '.' || clawParam.startsWith('.')) {
        return {
          success: false,
          content: `Error: Invalid claw ID: "${clawParam}"`,
        };
      }
      // Resolve path relative to target claw's workspaceDir (clawspace), same contract as local read.
      // "../" escapes clawspace to claw root, blocked from going beyond.
      const clawsDir = nodePath.join(ctx.clawforumRoot, CLAWS_DIR);
      const targetClawDir = nodePath.join(clawsDir, clawParam);
      const targetWorkspaceDir = nodePath.join(targetClawDir, CLAWSPACE_DIR);
      const normalizedPath = nodePath.normalize(filePath);
      const targetPath = nodePath.resolve(targetWorkspaceDir, normalizedPath);
      if (targetPath !== targetClawDir && !targetPath.startsWith(targetClawDir + nodePath.sep)) {
        return {
          success: false,
          content: `Error: Path escapes target claw root: "${filePath}"`,
        };
      }
      // Cross-claw read: per-target NodeFileSystem scoped to target clawspace
      try {
        const targetFs = ctx.fsFactory(targetWorkspaceDir);
        content = await targetFs.read(normalizedPath);
      } catch (error) {
        return {
          success: false,
          content: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } else {
      try {
        content = await ctx.fs.read(resolved);
      } catch (error) {
        return {
          success: false,
          content: `Error reading file: ${error instanceof Error ? error.message : String(error)}\nTip: To read another claw's file, use the "claw" parameter: { "path": "contract/xxx.json", "claw": "<claw-id>" }`,
        };
      }
    }

    // Capture full file content for hash + future FileState write before slicing mutates it.
    const fullFileContent = content;

    // Same-claw: stat for mtime (used in FileState; cross-claw skips write entirely)
    let fileMtime: number | undefined;
    if (clawParam === undefined) {
      try {
        const stat = await ctx.fs.stat(resolved);
        fileMtime = stat.mtime.getTime();
      } catch {
        // silent: stat failure here means FileState cannot be written for this read;
        // downstream gate will reject overwrite (no isFullRead=true entry) — fail-safe.
      }
    }

    try {
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
      content = fileLines.slice(start, end).join('\n');

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

      // readFileState write — same-claw only (cross-claw must not pollute caller's gate per §7.A.invariant)
      if (clawParam === undefined && fileMtime !== undefined) {
        // phase 1444: isFullRead = "this read covered every current line of the file".
        // Decoupled from rangeRequested — an explicit `limit >= totalLines` read also counts.
        // (Removes the 200-line cliff that effectively banned overwrite of larger files.)
        const sawAllLines = start === 0 && end >= totalLines;
        const isFullRead = sawAllLines && !byteCapTriggered;
        ctx.readFileState.set(resolved, {
          hash: computeContentHash(fullFileContent),
          timestamp: fileMtime,
          isFullRead,
        });
      }

      return {
        success: true,
        content,
      };
    } catch (error) {
      return {
        success: false,
        content: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
