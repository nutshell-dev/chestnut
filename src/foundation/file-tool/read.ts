/**
 * @module L2.FileTool
 * read tool - Read file contents
 *
 * Cross-claw access: `claw: "<id>"` targets another claw (read/ls do NOT implement `"*"` broadcast — only search does).
 */

import * as nodePath from 'path';
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import { READ_MAX_LINES, READ_MAX_CHARS } from './constants.js';

import { resolveWorkspacePath } from './resolve-path.js';
import { safeNumber } from '../utils/format.js';

import { CLAWS_DIR, CLAWSPACE_DIR } from '../paths.js';
export const READ_TOOL_NAME = 'read' as const;

export const readTool: Tool = {
  name: READ_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  group: 'fs-read',
  description: 'Read a file in your clawspace. Path is relative to clawspace (do NOT prefix with "clawspace/"). Use "../" in path to access claw root (e.g., "../MEMORY.md"). Use claw: "<id>" to read another claw\'s files.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (relative to clawspace, with "../" allowed for claw root access)',
      },
      offset: {
        type: 'number',
        description: 'Starting line number (1-indexed). Negative values count from end: -10 = last 10 lines',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read (optional)',
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
      // Safety limits (from constants.ts)
      try {
        content = await ctx.fs.read(resolved);
      } catch (error) {
        return {
          success: false,
          content: `Error reading file: ${error instanceof Error ? error.message : String(error)}\nTip: To read another claw's file, use the "claw" parameter: { "path": "contract/xxx.json", "claw": "<claw-id>" }`,
        };
      }
    }

    // Post-processing (offset/limit/truncation) - shared for both paths
    try {
      // Apply line range if specified
      if (offset !== undefined || limit !== undefined) {
        const lines = content.split('\n');
        let start = (offset ?? 1) - 1;
        if (start < 0) start = Math.max(0, lines.length + start + 1);
        const end = limit !== undefined ? start + limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }

      // Apply safety limits with meta info
      const totalLines = content.split('\n').length;
      const totalChars = content.length;
      const lines = content.split('\n');
      
      let isTruncated = false;
      if (lines.length > READ_MAX_LINES) {
        content = lines.slice(0, READ_MAX_LINES).join('\n') +
          `\n[Showing lines 1-${READ_MAX_LINES} of ${totalLines}. Use offset=${READ_MAX_LINES+1} to read more]`;
        isTruncated = true;
      }
      if (content.length > READ_MAX_CHARS) {
        const shownChars = content.slice(0, READ_MAX_CHARS).length;
        content = content.slice(0, READ_MAX_CHARS) +
          `\n[Showing first ${shownChars} of ${totalChars} chars. Use offset/limit to read more]`;
        isTruncated = true;
      }

      // fully-read 集合 add（未截断 / phase 487 G6 (a) / phase 537 cross-claw 不入同 claw 闸）
      if (!isTruncated && clawParam === undefined) {
        ctx.fullyReadPaths.add(resolved);
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
