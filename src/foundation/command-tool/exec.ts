/**
 * exec tool - Execute shell commands
 *
 * Thin wrapper over ProcessExec.
 * Responsible for: argument extraction, context injection, output truncation, ToolResult formatting.
 *
 * phase 758: motion-chain self-kill guard 已从 L2c 移除，改为通过可选的
 * `preExecGuard` 回调注入。具体 guard 实现见 L6 assembly/anti-self-kill.ts。
 */

import type { ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import type { Tool } from '../tools/index.js';
import { newShortUuid } from  '../node-utils/index.js';
import * as path from 'path';
import { EXEC_MAX_OUTPUT, EXEC_OVERFLOW_DIR_NAME, EXEC_COMMAND_PLACEHOLDER_CHARS } from './constants.js';

import { exec, execWithHandle } from '../process-exec/index.js';
import { ProcessExecError } from '../process-exec/index.js';
import { PROCESS_EXEC_DEFAULT_TIMEOUT_MS } from '../process-exec/index.js';
import type { ExecHandle } from '../process-exec/index.js';
import { formatErr } from '../node-utils/index.js';
import { truncateHeadTail } from '../file-tool/truncate-head-tail.js';
import { COMMAND_TOOL_AUDIT_EVENTS } from './audit-events.js';

function toSafeNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) || !Number.isFinite(n) ? undefined : n;
}

export interface PreExecGuard {
  (command: string): { allow: true } | { allow: false; reason: string };
}

export interface ExecWithHandleArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}

interface ResolvedExecArgs {
  command: string;
  cwd: string;
  timeoutMs: number | undefined;
  env: Record<string, string> | undefined;
  stdin: string | undefined;
}

function resolveExecArgs(
  args: { command: string; cwd?: string; timeoutMs?: number; stdin?: string },
  ctx: ExecContext,
): ResolvedExecArgs {
  const cwd = args.cwd
    ? (path.isAbsolute(args.cwd) ? args.cwd : path.resolve(ctx.workspaceDir, args.cwd))
    : ctx.workspaceDir;
  const timeoutMs = toSafeNumber(args.timeoutMs);
  const env = ctx.subagentTaskId
    ? { ...process.env, CHESTNUT_SUBAGENT_TASK_ID: ctx.subagentTaskId }
    : undefined;
  return {
    command: args.command,
    cwd,
    timeoutMs,
    env,
    stdin: args.stdin,
  };
}

function truncate(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '\n[truncated]';
}

// phase 524: HEAD/TAIL 常量 + truncateHeadTail 抽 foundation/file-tool/truncate-head-tail.ts。
// EXEC_MAX_OUTPUT === TRUNCATE_TOTAL_LIMIT === HEAD + TAIL = 2000B（业务 truncation 协议）。
// caller 均在 `if (output.length > EXEC_MAX_OUTPUT)` 内调用、无需 helper 内重复阈值判。

function formatNoOutput(command: string): string {
  const short = command.length > EXEC_COMMAND_PLACEHOLDER_CHARS
    ? command.slice(0, EXEC_COMMAND_PLACEHOLDER_CHARS) + '[truncated]'
    : command;
  return `(no output)\n[command]: ${short}`;
}

async function persistOverflow(
  ctx: ExecContext,
  output: string,
): Promise<string | null> {
  try {
    const id = newShortUuid();
    // exec_overflow scratch 写到 tasks/sync/exec/ 子目录（phase 511 / phase772 const 归正 / phase 1475 常量化消 non-null assertion）
    const fullPath = path.join(ctx.syncDir, EXEC_OVERFLOW_DIR_NAME, `${id}.md`);
    const frontmatter = `---\nsource: exec_overflow\ncontent_length: ${output.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + output);
    return path.relative(ctx.workspaceDir, fullPath);
  } catch (err) {
    ctx.auditWriter?.write(COMMAND_TOOL_AUDIT_EVENTS.OVERFLOW_PERSIST_FAILED, `reason=${formatErr(err)}`);
    return null;
  }
}

export const EXEC_TOOL_NAME = 'exec' as const;

export function createExecTool(preExecGuard?: PreExecGuard): Tool {
  return {
    name: EXEC_TOOL_NAME,
    profiles: ['full', 'subagent', 'miner'],
    group: 'exec',
    description: 'Execute a shell command in your clawspace. Runs via `sh -c`, so shell features (pipes, redirects, quotes) work normally. Relative paths resolve against your clawspace.',
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command string to execute, e.g. "ls -la" or "grep -r foo . | head -20"',
        },
        cwd: {
          type: 'string',
          description: 'Working directory, relative to clawspace. Use ".." to escape clawspace to claw root (e.g. cwd: "../memory"). Default: clawspace.',
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
    defaultTimeoutMs: PROCESS_EXEC_DEFAULT_TIMEOUT_MS,

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const { command, cwd, timeoutMs, env, stdin } = resolveExecArgs({
        command: args.command as string,
        cwd: args.cwd as string | undefined,
        timeoutMs: args.timeoutMs as number | undefined,
        stdin: args.stdin as string | undefined,
      }, ctx);

      if (preExecGuard) {
        const result = preExecGuard(command);
        if (!result.allow) {
          ctx.auditWriter?.write(
            COMMAND_TOOL_AUDIT_EVENTS.EXEC_MOTION_SELF_KILL_BLOCKED,
            `clawId=${ctx.clawId}`,
            `reason=${result.reason}`,
          );
          return { success: false, content: result.reason };
        }
      }

      // phase 1280: allow/deny reject 路径已 REFRAMED-OUT by-design 2026-05-25 user ratify
      // 未来 restriction 走 OS-level sandbox / 详 design §A.r136-cmd-tool-no-perm-mgmt-cleanup

      try {
        const result = await exec('sh', ['-c', command], {
          cwd,
          timeout: timeoutMs,
          signal: ctx.signal,
          stdin,
          env,
        });

        if (result.output.length > EXEC_MAX_OUTPUT) {
          const relPath = await persistOverflow(ctx, result.output);
          const content = relPath
            ? truncateHeadTail(result.output, relPath)
            : truncate(result.output, EXEC_MAX_OUTPUT);
          return { success: true, content };
        }
        return { success: true, content: result.output || formatNoOutput(command) };
      } catch (error) {
        // cwd hint 已删（phase: 心智收敛 workspace-relative / error 已含 LLM 自己的 tool_use，cwd 信息冗余）
        if (!(error instanceof ProcessExecError)) {
          return {
            success: false,
            content: `Error: ${formatErr(error)}`,
          };
        }

        // maxBuffer exceeded
        if (error.maxBufferExceeded) {
          if (error.output.length > EXEC_MAX_OUTPUT) {
            const relPath = await persistOverflow(ctx, error.output);
            const truncated = relPath
              ? truncateHeadTail(error.output, relPath)
              : truncate(error.output, EXEC_MAX_OUTPUT);
            return { success: false, content: `Error: command output exceeded 1 MB limit.\n[output]: ${truncated}` };
          }
          const partial = error.output
            ? `\n[partial output]: ${truncate(error.output, EXEC_MAX_OUTPUT)}`
            : '';
          return {
            success: false,
            content: `Error: command output exceeded 1 MB limit. Use head/tail to truncate, or redirect to a file.${partial}`,
          };
        }

        // phase 1417: ToolResult.success 契约语义 reframe
        //   success: false ⇔ 工具自身没完成契约（spawn-error / timeout / signal-kill / maxBuffer / abort）
        //   success: true  ⇔ 工具完成契约（output 已交回 agent），无论 command 自己 exit 几
        // exit code 是 agent 自己解读的语义信号（grep 无匹配 / diff 有差异 / test 退出码）。
        // L1 process-exec 表面不动（snapshot/verification/cron caller 仍享 reject-on-non-zero 便利层）。
        // 判据：killed=true（timeout/signal-kill）或 exitCode=null（spawn-error）→ 真异常 success:false
        //        其他（纯非零 exit）→ success:true，content 头带 [exit N]
        const isRealFailure = error.killed === true || error.exitCode === null;

        if (isRealFailure) {
          if (error.output.length > EXEC_MAX_OUTPUT) {
            const relPath = await persistOverflow(ctx, error.output);
            const truncated = relPath
              ? truncateHeadTail(error.output, relPath)
              : truncate(error.output, EXEC_MAX_OUTPUT);
            return { success: false, content: `Error: ${error.message}\n[command]: ${command}\n[output]: ${truncated}` };
          }
          const output = error.output ? `\n[output]: ${truncate(error.output, EXEC_MAX_OUTPUT)}` : '';
          return { success: false, content: `Error: ${error.message}\n[command]: ${command}${output}` };
        }

        // 纯非零退出码：command 自己语义信号、tool 已完成契约
        const exitLine = `[exit ${error.exitCode}]`;
        const short = command.length > EXEC_COMMAND_PLACEHOLDER_CHARS
          ? command.slice(0, EXEC_COMMAND_PLACEHOLDER_CHARS) + '[truncated]'
          : command;
        if (error.output.length > EXEC_MAX_OUTPUT) {
          const relPath = await persistOverflow(ctx, error.output);
          const truncated = relPath
            ? truncateHeadTail(error.output, relPath)
            : truncate(error.output, EXEC_MAX_OUTPUT);
          return { success: true, content: `${exitLine}\n[command]: ${short}\n${truncated}` };
        }
        const body = error.output
          ? `[command]: ${short}\n${truncate(error.output, EXEC_MAX_OUTPUT)}`
          : formatNoOutput(command);
        return { success: true, content: `${exitLine}\n${body}` };
      }
    },
  };
}

/**
 * Factory for a low-level exec helper that returns an ExecHandle instead of a
 * ToolResult. Reuses the same argument resolution (cwd, env, timeout) as
 * createExecTool, but surfaces exceptions directly so L4 callers can manage the
 * ChildProcess lifecycle.
 */
export function createExecWithHandle(preExecGuard?: PreExecGuard) {
  return async function execWithHandleFn(
    args: ExecWithHandleArgs,
    ctx: ExecContext,
  ): Promise<ExecHandle> {
    const { command, cwd, timeoutMs, env, stdin } = resolveExecArgs(args, ctx);

    if (preExecGuard) {
      const result = preExecGuard(command);
      if (!result.allow) {
        throw new Error(result.reason);
      }
    }

    return execWithHandle('sh', ['-c', command], {
      cwd,
      timeout: timeoutMs,
      signal: ctx.signal,
      stdin,
      env,
    });
  };
}

// singleton execTool export (phase 1280: factory now 0-arg / REFRAMED-OUT)
export const execTool = createExecTool();
