/**
 * exec tool - Execute shell commands
 *
 * Thin wrapper over ProcessExec.
 * Responsible for: argument extraction, context injection, output truncation, ToolResult formatting.
 */

import type { ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import type { Tool } from '../tools/index.js';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { UUID_SHORT_LEN } from '../../constants.js';
import { EXEC_MAX_OUTPUT } from './constants.js';
import { TASKS_SYNC_EXEC_DIR } from './constants.js';
import { exec } from '../process-exec/index.js';
import { ProcessExecError } from '../process-exec/index.js';
import { PROCESS_EXEC_DEFAULT_TIMEOUT_MS } from '../process-exec/index.js';
import { formatErr, safeNumber } from '../utils/format.js';

function truncate(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '\n[truncated]';
}

const HEAD_LIMIT = 600;
const TAIL_LIMIT = 1400;
// EXEC_MAX_OUTPUT = 2000 (HEAD + TAIL = 2000)

function truncateHeadTail(output: string, relPath: string): string {
  if (output.length <= EXEC_MAX_OUTPUT) return output;
  const head = output.slice(0, HEAD_LIMIT);
  const tail = output.slice(-TAIL_LIMIT);
  const truncatedBytes = output.length - HEAD_LIMIT - TAIL_LIMIT;
  return `${head}\n[...truncated ${truncatedBytes} bytes...]\n${tail}\nFull output saved to: ${relPath}`;
}

async function persistOverflow(
  ctx: ExecContext,
  output: string,
): Promise<string | null> {
  try {
    const id = randomUUID().slice(0, UUID_SHORT_LEN);
    // exec_overflow scratch 写到 tasks/sync/exec/ 子目录（phase 511 / phase772 const 归正）
    const fullPath = path.join(ctx.syncDir, TASKS_SYNC_EXEC_DIR.split('/').pop()!, `${id}.md`);
    const frontmatter = `---\nsource: exec_overflow\ncontent_length: ${output.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + output);
    return path.relative(ctx.clawDir, fullPath);
  } catch (err) {
    ctx.auditWriter?.write('overflow_persist_failed', `reason=${formatErr(err)}`);
    return null;
  }
}

export const EXEC_TOOL_NAME = 'exec' as const;

export function createExecTool(): Tool {
  return {
    name: EXEC_TOOL_NAME,
    profiles: ['full', 'subagent', 'miner'],
    group: 'llm',
    description: 'Execute a shell command in your agent workspace. Runs via `sh -c`, so shell features (pipes, redirects, quotes) work normally. Relative paths resolve against your workspace root.',
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command string to execute, e.g. "ls -la" or "grep -r foo . | head -20"',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (relative path resolved against workspace root, or absolute, with ".." to escape workspace). Default: workspace root.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds (default ${PROCESS_EXEC_DEFAULT_TIMEOUT_MS})`,
        },
        stdin: {
          type: 'string',
          description: 'Content to pipe to the command stdin. Use "cat > file" with this instead of heredoc to avoid shell escaping issues.',
        },
      },
      required: ['command'],
    },
    readonly: false,
    idempotent: false,
    supportsAsync: true,

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const command = args.command as string;

      // phase 1280: allow/deny reject 路径已 REFRAMED-OUT by-design 2026-05-25 user ratify
      // 未来 restriction 走 OS-level sandbox / 详 design §A.r136-cmd-tool-no-perm-mgmt-cleanup

      const cwdArg = args.cwd as string | undefined;
      const cwd = cwdArg
        ? (path.isAbsolute(cwdArg) ? cwdArg : path.resolve(ctx.workspaceDir, cwdArg))   // phase 519: workspace-relative
        : ctx.workspaceDir;            // phase 512 / per-callerType: 主代理=clawspace / 子代理=tasks/subagents/<id>
      const timeoutMs = safeNumber(args.timeoutMs);

      try {
        const result = await exec('sh', ['-c', command], {
          cwd,
          timeout: timeoutMs,
          signal: ctx.signal,
          stdin: args.stdin as string | undefined,
        });

        if (result.output.length > EXEC_MAX_OUTPUT) {
          const relPath = await persistOverflow(ctx, result.output);
          const content = relPath
            ? truncateHeadTail(result.output, relPath)
            : truncate(result.output, EXEC_MAX_OUTPUT);
          return { success: true, content };
        }
        return { success: true, content: result.output || '(no output)' };
      } catch (error) {
        // 失败时总是附上 cwd，防止 LLM 对路径上下文产生幻觉（例如误以为在根目录）
        const cwdHint = `\n[cwd]: ${cwd}`;

        if (!(error instanceof ProcessExecError)) {
          return {
            success: false,
            content: `Error: ${error instanceof Error ? error.message : String(error)}${cwdHint}`,
          };
        }

        // maxBuffer exceeded
        if (error.maxBufferExceeded) {
          if (error.output.length > EXEC_MAX_OUTPUT) {
            const relPath = await persistOverflow(ctx, error.output);
            const truncated = relPath
              ? truncateHeadTail(error.output, relPath)
              : truncate(error.output, EXEC_MAX_OUTPUT);
            return { success: false, content: `Error: command output exceeded 1 MB limit.${cwdHint}\n[output]: ${truncated}` };
          }
          const partial = error.output
            ? `\n[partial output]: ${truncate(error.output, EXEC_MAX_OUTPUT)}`
            : '';
          return {
            success: false,
            content: `Error: command output exceeded 1 MB limit. Use head/tail to truncate, or redirect to a file.${partial}${cwdHint}`,
          };
        }

        // General error (non-zero exit code, timeout, etc.)
        if (error.output.length > EXEC_MAX_OUTPUT) {
          const relPath = await persistOverflow(ctx, error.output);
          const truncated = relPath
            ? truncateHeadTail(error.output, relPath)
            : truncate(error.output, EXEC_MAX_OUTPUT);
          return { success: false, content: `Error: ${error.message}${cwdHint}\n[output]: ${truncated}` };
        }
        const output = error.output ? `\n[output]: ${truncate(error.output, EXEC_MAX_OUTPUT)}` : '';

        return {
          success: false,
          content: `Error: ${error.message}${output}${cwdHint}`,
        };
      }
    },
  };
}

// singleton execTool export (phase 1280: factory now 0-arg / REFRAMED-OUT)
export const execTool = createExecTool();
