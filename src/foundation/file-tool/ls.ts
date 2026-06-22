/**
 * @module L2.FileTool
 * ls tool - List directory contents
 */

import * as nodePath from 'path';
import { z } from 'zod';
import { formatErr } from "../utils/index.js";
import type { Tool, ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import { LS_MAX_ENTRIES } from './constants.js';

import { resolveWorkspacePath } from './resolve-path.js';
import { defineFileToolSchema } from './_zod-helper.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';


export const LS_TOOL_NAME = 'ls' as const;

const LsInputSchema = z.object({
  path: z.string().optional().describe(
    'Directory path (workspace-relative, "../" allowed for claw root access)'
  ),
}).strict();

type LsInput = z.infer<typeof LsInputSchema>;

export const lsTool: Tool = {
  name: LS_TOOL_NAME,
  profiles: ['full', 'readonly', 'subagent', 'miner'],
  group: 'fs-read',
  description: 'List files. Path resolves against your clawspace; use "../" to access claw root subdirs (e.g. "../memory").',
  schema: defineFileToolSchema(LsInputSchema),
  readonly: true,
  idempotent: true,
  supportsAsync: false,

  async execute(rawArgs: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    let args: LsInput;
    try {
      args = LsInputSchema.parse(rawArgs);
    } catch (err) {
      // phase 692: 拆 tool + error 为两 col、与 phase 690/691 同模式
      ctx.auditWriter?.write(
        FILE_TOOL_AUDIT_EVENTS.INPUT_VALIDATION_FAILED,
        `tool=ls`,
        `error=${formatErr(err)}`,
      );
      return {
        success: false,
        content: `ls tool input validation failed: ${(err as Error).message}`,
      };
    }

    const pathArg = args.path ?? '.';
    // From constants.ts: pagination limit

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

    try {
      const entries = await ctx.fs.list(resolved, { includeDirs: true });

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
        const displayPath = nodePath.relative(resolved, e.path) || '.';
        return `${type} ${displayPath}${size}`;
      });

      const suffix = total > LS_MAX_ENTRIES ? `\n... ${total} entries total` : '';

      return {
        success: true,
        content: lines.join('\n') + suffix,
      };
    } catch (error) {
      return {
        success: false,
        content: `Error listing directory: ${formatErr(error)}`,
      };
    }
  },
};
