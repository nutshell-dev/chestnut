/**
 * exec tool - Execute shell commands
 *
 * Thin wrapper over ProcessExec.
 * Responsible for: argument extraction, context injection, output truncation, ToolResult formatting.
 *
 * phase 1473 exception: 见下方 §guard — motion-chain self-kill 拒绝路径
 * （`looksLikeChestnutSelfKill` + `ctx.isMotionChain`）。范畴属「存活语义」
 * 而非 application-level 权限管理，与 phase 1280 REFRAMED-OUT 不冲突。
 * 详 ../index.ts 顶 docblock phase 1473 豁免说明段。
 */

import type { ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import type { Tool } from '../tools/index.js';
import { newShortUuid } from  '../node-utils/index.js';
import * as path from 'path';
import { EXEC_MAX_OUTPUT, EXEC_OVERFLOW_DIR_NAME, EXEC_COMMAND_PLACEHOLDER_CHARS } from './constants.js';

import { exec } from '../process-exec/index.js';
import { ProcessExecError } from '../process-exec/index.js';
import { PROCESS_EXEC_DEFAULT_TIMEOUT_MS } from '../process-exec/index.js';
import { formatErr } from '../node-utils/index.js';
import { truncateHeadTail } from '../file-tool/truncate-head-tail.js';
import { COMMAND_TOOL_AUDIT_EVENTS } from './audit-events.js';

/**
 * Detect commands that would kill the motion daemon process itself.
 *
 * Matches:
 *   - `chestnut stop`        (kills watchdog → motion → claws)
 *   - `chestnut motion stop` (kills motion only)
 *
 * Does NOT match `chestnut watchdog stop` (doesn't directly kill motion).
 *
 * Accepted false positive: `echo "chestnut stop"` is also blocked.
 * Threat model is well-meaning agent, not adversary — shell evasion
 * (eval, env-var splicing, path tricks) is out of scope.
 */
function toSafeNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) || !Number.isFinite(n) ? undefined : n;
}

function looksLikeChestnutSelfKill(command: string): boolean {
  return /\bchestnut\s+(motion\s+)?stop\b/i.test(command);
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

export function createExecTool(): Tool {
  return {
    name: EXEC_TOOL_NAME,
    profiles: ['full', 'subagent', 'miner'],
    group: 'llm',
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

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const command = args.command as string;

      // phase 1473: motion-chain self-kill guard
      //   motion 调 `chestnut stop` / `chestnut motion stop` → SIGTERM 自身进程
      //   → in-flight tool_use_result 丢失 → motion 重启回到悬挂 tool_use
      //   → LLM 再次发起 stop → 死循环
      if (ctx.isMotionChain && looksLikeChestnutSelfKill(command)) {
        ctx.auditWriter?.write(
          COMMAND_TOOL_AUDIT_EVENTS.EXEC_MOTION_SELF_KILL_BLOCKED,
          `clawId=${ctx.clawId}`,
          `command=${ctx.auditWriter?.message(command) ?? command}`,
        );
        return {
          success: false,
          content:
            'Error: motion-chain cannot exec `chestnut stop` / `chestnut motion stop` ' +
            'via shell. The command SIGTERMs motion itself; the in-flight tool result ' +
            'is lost, and after restart motion re-issues the same command (infinite ' +
            'loop). To stop motion, ask the user or use an external CLI process. ' +
            '(phase 1473 guard)',
        };
      }

      // phase 1280: allow/deny reject 路径已 REFRAMED-OUT by-design 2026-05-25 user ratify
      // 未来 restriction 走 OS-level sandbox / 详 design §A.r136-cmd-tool-no-perm-mgmt-cleanup

      const cwdArg = args.cwd as string | undefined;
      const cwd = cwdArg
        ? (path.isAbsolute(cwdArg) ? cwdArg : path.resolve(ctx.workspaceDir, cwdArg))   // phase 519: workspace-relative
        : ctx.workspaceDir;            // phase 512 / per-callerType: 主代理=clawspace / 子代理=tasks/subagents/<id>
      const timeoutMs = toSafeNumber(args.timeoutMs);

      try {
        const env = ctx.subagentTaskId
          ? { ...process.env, CHESTNUT_SUBAGENT_TASK_ID: ctx.subagentTaskId }
          : undefined;   // 不设 = 走 process-exec 默认继承 process.env、维持现状

        const result = await exec('sh', ['-c', command], {
          cwd,
          timeout: timeoutMs,
          signal: ctx.signal,
          stdin: args.stdin as string | undefined,
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
            return { success: false, content: `Error: ${error.message}\n[output]: ${truncated}` };
          }
          const output = error.output ? `\n[output]: ${truncate(error.output, EXEC_MAX_OUTPUT)}` : '';
          return { success: false, content: `Error: ${error.message}${output}` };
        }

        // 纯非零退出码：command 自己语义信号、tool 已完成契约
        const exitLine = `[exit ${error.exitCode}]`;
        if (error.output.length > EXEC_MAX_OUTPUT) {
          const relPath = await persistOverflow(ctx, error.output);
          const truncated = relPath
            ? truncateHeadTail(error.output, relPath)
            : truncate(error.output, EXEC_MAX_OUTPUT);
          return { success: true, content: `${exitLine}\n${truncated}` };
        }
        const body = error.output || formatNoOutput(command);
        return { success: true, content: `${exitLine}\n${body}` };
      }
    },
  };
}

// singleton execTool export (phase 1280: factory now 0-arg / REFRAMED-OUT)
export const execTool = createExecTool();
