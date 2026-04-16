/**
 * exec tool - Execute shell commands
 *
 * Thin wrapper over ProcessExec.
 * Responsible for: argument extraction, context injection, output truncation, ToolResult formatting.
 */

import type { ITool, ToolResult, ExecContext } from '../executor.js';
import {
  EXEC_MAX_STDOUT,
  EXEC_MAX_STDERR,
} from '../../../constants.js';
import { exec } from '../../../foundation/process-exec/index.js';
import { ProcessExecError } from '../../../foundation/process-exec/index.js';
import { PROCESS_EXEC_DEFAULT_TIMEOUT_MS } from '../../../foundation/process-exec/index.js';

function truncate(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '\n[truncated]';
}

export const execTool: ITool = {
  name: 'exec',
  description: 'Execute a shell command in the claw root directory. Runs via `sh -c`, so shell features (pipes, redirects, quotes) work normally.',
  schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command string to execute, e.g. "ls -la" or "grep -r foo ./clawspace | head -20"',
      },
      timeout: {
        type: 'number',
        description: `Timeout in milliseconds (default ${PROCESS_EXEC_DEFAULT_TIMEOUT_MS})`,
      },
      async: {
        type: 'boolean',
        description: 'If true, run command in background. Result delivered to inbox when complete. Use for long-running commands (>30s).',
      },
    },
    required: ['command'],
  },
  readonly: false,
  idempotent: false,
  supportsAsync: true,

  async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
    const command = args.command as string;
    const timeout = (args.timeout as number) ?? undefined;

    try {
      const result = await exec(command, {
        cwd: ctx.clawDir,
        timeout,
        signal: ctx.signal,
        env: ctx.originClawId && ctx.originClawId !== ctx.clawId
          ? { CLAW_ORIGIN_ID: ctx.originClawId }
          : undefined,
      });

      // Truncate output for LLM context window
      const stdout = truncate(result.stdout, EXEC_MAX_STDOUT);
      const stderr = truncate(result.stderr, EXEC_MAX_STDERR);

      const fullOutput = stdout + (stderr ? '\n[stderr]: ' + stderr : '') || '(no output)';

      return {
        success: true,
        content: fullOutput,
      };
    } catch (error) {
      // 失败时总是附上 cwd，防止 LLM 对路径上下文产生幻觉（例如误以为在根目录）
      const cwdHint = `\n[cwd]: ${ctx.clawDir}`;

      if (!(error instanceof ProcessExecError)) {
        return {
          success: false,
          content: `Error: ${error instanceof Error ? error.message : String(error)}${cwdHint}`,
        };
      }

      // maxBuffer exceeded
      if (error.maxBufferExceeded) {
        const partial = error.stdout
          ? `\n[partial stdout]: ${truncate(error.stdout, EXEC_MAX_STDOUT)}`
          : '';
        return {
          success: false,
          content: `Error: command output exceeded 1 MB limit. Use head/tail to truncate, or redirect to a file.${partial}${cwdHint}`,
        };
      }

      // General error (non-zero exit code, timeout, etc.)
      const stderr = error.stderr ? `\n[stderr]: ${truncate(error.stderr, EXEC_MAX_STDERR)}` : '';
      const stdout = error.stdout ? `\n[stdout]: ${truncate(error.stdout, EXEC_MAX_STDOUT)}` : '';

      return {
        success: false,
        content: `Error: ${error.message}${stderr}${stdout}${cwdHint}`,
      };
    }
  },
};
