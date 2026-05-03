/**
 * @module L2.FileTool
 * ls tool - List directory contents
 *
 * Motion-only: can list other claws' directories via `claw` parameter
 */

import * as nodePath from 'path';
import * as fsNative from 'fs';
import type { Tool, ToolResult, ExecContext } from '../tool-protocol/index.js';
import { LS_MAX_ENTRIES } from '../../constants.js';
import { getChecker } from './permission-context.js';

import { LS_TOOL_NAME } from '../tools/tool-names.js';
export { LS_TOOL_NAME };

export const lsTool: Tool = {
  name: LS_TOOL_NAME,
  description: 'List files and directories in the specified path. Motion can list other claws via `claw` parameter.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path to list, relative to YOUR OWN claw directory. To list another claw\'s files, use the "claw" parameter instead of putting their path here.',
      },
      claw: {
        type: 'string',
        description: 'Target claw ID (Motion only). e.g. { "path": "contract/archive", "claw": "claw1" }',
      },
      async: {
        type: 'boolean',
        description: 'If true, run in background. Result delivered to inbox when complete. Use for large directories or non-blocking listings.',
      },
    },
    required: [],
  },
  readonly: true,
  idempotent: true,
  supportsAsync: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const path = (args.path as string) ?? '.';
    const clawParam = args.claw as string | undefined;
    // From constants.ts: pagination limit

    // Motion-only: list directory in another claw
    let targetPath: string;
    let entries: { path: string; isDirectory: boolean; isFile: boolean; size?: number }[];

    // Phase430: claw-space boundary check — caller autonomy
    const checker = getChecker(ctx.clawDir);
    checker.resolveAndCheck(path, 'read');

    if (clawParam !== undefined) {
      // Only Motion can use this feature
      if (!ctx.isMotionChain) {
        return {
          success: false,
          content: 'Error: Only Motion and its subagents can list directories from other claws',
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
      targetPath = nodePath.resolve(ctx.clawDir, '..', 'claws', clawParam, path);
      // Escape check: must be within the target claw's directory
      const clawsDir = nodePath.resolve(ctx.clawDir, '..', 'claws');
      const clawRoot = nodePath.join(clawsDir, clawParam);
      if (targetPath !== clawRoot && !targetPath.startsWith(clawRoot + nodePath.sep)) {
        return {
          success: false,
          content: `Error: Path escapes target claw directory: "${path}"`,
        };
      }
      // Read directly using native fs (skip ctx.fs permissions)
      try {
        const dirents = await fsNative.promises.readdir(targetPath, { withFileTypes: true });
        entries = await Promise.all(dirents.map(async d => {
          const stat = d.isFile() 
            ? await fsNative.promises.stat(nodePath.join(targetPath, d.name))
            : undefined;
          return {
            path: d.name,
            isDirectory: d.isDirectory(),
            isFile: d.isFile(),
            size: stat?.size,
          };
        }));
      } catch (error) {
        return {
          success: false,
          content: `Error listing directory: ${error instanceof Error ? error.message : String(error)}\nTip: To list another claw's directory, use the "claw" parameter: { "path": "contract/", "claw": "<claw-id>" }`,
        };
      }
    } else {
      // Normal list (within current claw)
      try {
        entries = await ctx.fs.list(path, { includeDirs: true });
      } catch (error) {
        return {
          success: false,
          content: `Error listing directory: ${error instanceof Error ? error.message : String(error)}\nTip: To list another claw's directory, use the "claw" parameter: { "path": "contract/", "claw": "<claw-id>" }`,
        };
      }
    }

    if (entries.length === 0) {
      return {
        success: true,
        content: 'Directory is empty',
      };
    }

    const total = entries.length;
    const limited = entries.slice(0, LS_MAX_ENTRIES);
    
    const lines = limited.map(e => {
      const type = e.isDirectory ? '[DIR]' : '[FILE]';
      const size = e.isFile ? ` ${e.size} bytes` : '';
      return `${type} ${e.path}${size}`;
    });

    const suffix = total > LS_MAX_ENTRIES ? `\n... ${total} entries total` : '';

    return {
      success: true,
      content: lines.join('\n') + suffix,
    };
  },
};
