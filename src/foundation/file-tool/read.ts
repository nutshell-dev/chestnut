/**
 * @module L2.FileTool
 * read tool - Read file contents
 *
 * Cross-claw access: `claw: "<id>"` available to all agents; `claw: "*"` (if applicable) Motion-only.
 */

import * as nodePath from 'path';
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import { READ_MAX_LINES, READ_MAX_CHARS } from './constants.js';

import { resolveWorkspacePath } from './_resolve-path.js';
import { safeNumber } from '../utils/format.js';

import { CLAWS_DIR } from '../paths.js';
export const READ_TOOL_NAME = 'read' as const;

export const readTool: Tool = {
  name: READ_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  group: 'fs-read',
  description: 'Read a file in your agent workspace. Path is relative to your workspace root — do NOT prefix with "clawspace/". Use cwd: ".." to access files in your claw root (e.g., MEMORY.md). Use cwd: "memory" for subdirs. Use claw: "<id>" to read another claw\'s files (available to all agents); claw: "*" is Motion-only.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (default base: workspace root)',
      },
      cwd: {
        type: 'string',
        description: 'Override base for path resolution (relative to workspace root, or absolute, with ".." to escape workspace to claw root files like MEMORY.md). Default: workspace root.',
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
        description: 'Target claw ID (specific target available to all agents; broadcast Motion-only). e.g. { "path": "contract/xxx/progress.json", "claw": "claw1" }',
      },
    },
    required: ['path'],
  },
  readonly: true,
  idempotent: true,
  supportsAsync: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const filePath = args.path as string;
    const cwdArg = args.cwd as string | undefined;
    const offset = safeNumber(args.offset);
    const limit = safeNumber(args.limit);
    const clawParam = args.claw as string | undefined;

    const resolved = resolveWorkspacePath(ctx, filePath, cwdArg);
    if (resolved.startsWith('..') || resolved.startsWith('/')) {
      return {
        success: false,
        content: `Error: Path escapes claw directory: "${filePath}"${cwdArg ? ` (cwd: ${cwdArg})` : ''}`,
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
      // Validate clawParam (no path traversal)
      if (clawParam.includes('/') || clawParam.includes('..') || clawParam === '' || clawParam === '.' || clawParam.startsWith('.')) {
        return {
          success: false,
          content: `Error: Invalid claw ID: "${clawParam}"`,
        };
      }
      // Resolve path to target claw's directory
      const targetPath = nodePath.resolve(ctx.clawDir, '..', CLAWS_DIR, clawParam, nodePath.normalize(filePath));
      // Escape check: must be within the target claw's directory
      const clawsDir = nodePath.resolve(ctx.clawDir, '..', CLAWS_DIR);
      const clawRoot = nodePath.join(clawsDir, clawParam);
      if (targetPath !== clawRoot && !targetPath.startsWith(clawRoot + nodePath.sep)) {
        return {
          success: false,
          content: `Error: Path escapes target claw directory: "${filePath}"`,
        };
      }
      // Cross-claw read: per-target NodeFileSystem
      // Phase 1105: cross-claw permission check is a design decision — current PermissionChecker is caller-scoped,
      // not target-scoped. Direct claw-to-claw read permission is managed by hub-and-spoke topology (motion routes).
      try {
        const targetFs = ctx.fsFactory(nodePath.join(clawsDir, clawParam));
        content = await targetFs.read(nodePath.normalize(filePath));
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
