/**
 * @module L2.FileTool
 * ls tool - List directory contents
 *
 * Cross-claw access: `claw: "<id>"` targets another claw (read/ls do NOT implement `"*"` broadcast — only search does).
 */

import * as nodePath from 'path';
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import { LS_MAX_ENTRIES } from './constants.js';

import { resolveWorkspacePath } from './resolve-path.js';

import { CLAWS_DIR } from '../paths.js';
export const LS_TOOL_NAME = 'ls' as const;

export const lsTool: Tool = {
  name: LS_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  group: 'fs-read',
  description: 'List files in your clawspace. Path is relative to clawspace (do NOT prefix with "clawspace/"). Use "../" in path to access claw root subdirs (e.g., "../memory"). Use claw: "<id>" to list another claw\'s files.',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path to list (relative to clawspace, with "../" allowed for claw root access)',
      },
      claw: {
        type: 'string',
        description: 'Target claw ID. e.g. { "path": "contract/archive", "claw": "claw1" }',
      },
    },
    required: [],
  },
  readonly: true,
  idempotent: true,
  supportsAsync: false,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const pathArg = (args.path as string) ?? '.';
    const clawParam = args.claw as string | undefined;
    // From constants.ts: pagination limit

    // Cross-claw ls: specific target = any agent. ls does NOT implement '*' broadcast (only search does).
    let targetPath: string;
    let entries: { path: string; isDirectory: boolean; isFile: boolean; size?: number }[];

    const resolved = resolveWorkspacePath(ctx, pathArg);
    if (resolved.startsWith('..') || resolved.startsWith('/')) {
      return {
        success: false,
        content: `Error: Path escapes claw root: "${pathArg}"`,
      };
    }

    // Phase430: claw-space boundary check — caller autonomy
    const checker = ctx.permissionChecker;
    if (!checker) {
      throw new Error('FileTool.ls: ctx.permissionChecker not injected (Assembly should inject via createClawPermissionChecker)');
    }
    checker.resolveAndCheck(resolved, 'read');

    if (clawParam !== undefined) {
      if (!ctx.fsFactory) {
        return {
          success: false,
          content: 'Error: Cross-claw access not available in this context (fsFactory not injected)',
        };
      }
      // specific target / 任意 callerType OK（D11 inter-claw 互访 align）
      // Reject '*' explicitly — ls does not implement broadcast (only search does).
      // Without this, '*' silently falls through to ENOENT on <clawsDir>/*.
      if (clawParam === '*') {
        return {
          success: false,
          content: 'Error: claw: "*" broadcast is not supported by ls (only search supports it).',
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
      targetPath = nodePath.resolve(ctx.clawforumRoot, CLAWS_DIR, clawParam, nodePath.normalize(pathArg));
      // Escape check: must be within the target claw's directory
      const clawsDir = nodePath.join(ctx.clawforumRoot, CLAWS_DIR);
      const clawRoot = nodePath.join(clawsDir, clawParam);
      if (targetPath !== clawRoot && !targetPath.startsWith(clawRoot + nodePath.sep)) {
        return {
          success: false,
          content: `Error: Path escapes target claw root: "${pathArg}"`,
        };
      }
      // Cross-claw read: per-target NodeFileSystem (无 PermissionChecker = 等价 skip permissions)
      try {
        const targetFs = ctx.fsFactory(targetPath);
        entries = await targetFs.list('', { includeDirs: true });
      } catch (error) {
        return {
          success: false,
          content: `Error listing directory: ${error instanceof Error ? error.message : String(error)}\nTip: To list another claw's directory, use the "claw" parameter: { "path": "contract/", "claw": "<claw-id>" }`,
        };
      }
    } else {
      // Normal list (within current claw)
      try {
        entries = await ctx.fs.list(resolved, { includeDirs: true });
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
      // 跨 claw 分支：e.path 是相对 targetPath 的路径（targetFs baseDir = targetPath）/ 直接用
      // 同 claw 分支：e.path 是相对 ctx.fs baseDir 的路径 / relative(resolved, ...) 转 user-facing 显示
      const displayPath = clawParam !== undefined
        ? (e.path || '.')
        : (nodePath.relative(resolved, e.path) || '.');
      return `${type} ${displayPath}${size}`;
    });

    const suffix = total > LS_MAX_ENTRIES ? `\n... ${total} entries total` : '';

    return {
      success: true,
      content: lines.join('\n') + suffix,
    };
  },
};
