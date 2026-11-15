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
import type { ToolResult, ToolResultArtifact } from '../tool-protocol/index.js';
import type { Tool } from '../tools/index.js';
import { newShortUuid } from  '../node-utils/index.js';
import * as path from 'path';
import {
  COMMAND_TOOL_DEFAULT_TIMEOUT_MS,
  EXEC_MAX_OUTPUT,
  EXEC_COMMAND_PLACEHOLDER_CHARS,
  TASKS_SYNC_EXEC_DIR,
} from './constants.js';
import { CALLER_AGENT_ID_ENV } from './env.js';

import { exec, execWithHandle, resolveHostCommand } from '../process-exec/index.js';
import { ProcessExecError } from '../process-exec/index.js';
import { PROCESS_EXEC_DEFAULT_MAX_BUFFER } from '../process-exec/index.js';
import type { ExecHandle, ExecutionTerminationFact } from '../process-exec/index.js';
import { formatErr, truncateUtf8Prefix } from '../node-utils/index.js';
import { truncateHeadTail } from '../file-tool/index.js';
import { COMMAND_TOOL_AUDIT_EVENTS } from './audit-events.js';
import { rejectLongBlockingExec } from './blocking-policy.js';

function toSafeNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) || !Number.isFinite(n) ? undefined : n;
}

export interface PreExecGuard {
  (command: string): { allow: true } | { allow: false; guardKind: string; reason: string };
}

/**
 * phase 1863 (AT-D9/H1)：命令侧执行形态声明（owner：命令/工具侧）。
 * ATS 的 async exec wrapper 消费本声明决定「超过 soft timeout 之后的去向」：
 * - migratable: true（缺省）：迁移为后台持久任务（现状行为）；
 * - migratable: false：超时即终止（复用显式 timeout 语义；不建迁移任务、不写 TASK_MIGRATED_*）。
 * 声明归命令侧所有、经 Assembly 接线传入 wrapper（不扩 Tool 协议面）。
 */
export interface AsyncMigrationPolicy {
  readonly migratable: boolean;
  /** 覆盖装配级 soft timeout（ms）；缺省用接线注入值。 */
  readonly softTimeoutMs?: number;
}

/** exec 命令的声明：可迁移（现状行为 = 零漂移基线）。 */
export const EXEC_ASYNC_MIGRATION: AsyncMigrationPolicy = { migratable: true };

/**
 * Low-level exec handle args (phase 1272 Step C): the timeout strategy is
 * mutually exclusive at the type level — relative `timeoutMs` (business
 * budget, clamped by L1) or absolute `deadlineAtMs` (neutral epoch fact,
 * passed through to L1 untouched). The agent-facing tool schema does NOT
 * expose `deadlineAtMs`; only internal L4 callers may supply it.
 */
export type ExecWithHandleArgs = {
  command: string;
  cwd?: string;
  stdin?: string;
  /** Internal lifecycle checkpoint; never exposed in the agent tool schema. */
  onExecutionIdentity?: (identity: import('../process-exec/index.js').ExecutionIdentity) => void;
} & (
  | { timeoutMs?: number; deadlineAtMs?: never }
  | { timeoutMs?: never; deadlineAtMs?: number }
);

interface ResolvedExecArgs {
  command: string;
  cwd: string;
  timeoutMs: number | undefined;
  deadlineAtMs: number | undefined;
  env: Record<string, string> | undefined;
  stdin: string | undefined;
  onExecutionIdentity: ExecWithHandleArgs['onExecutionIdentity'];
}

function resolveExecArgs(
  args: { command: string; cwd?: string; timeoutMs?: number; deadlineAtMs?: number; stdin?: string; onExecutionIdentity?: ExecWithHandleArgs['onExecutionIdentity'] },
  ctx: ExecContext,
): ResolvedExecArgs {
  const cwd = args.cwd
    ? (path.isAbsolute(args.cwd) ? args.cwd : path.resolve(ctx.workspaceDir, args.cwd))
    : ctx.workspaceDir;
  const timeoutMs = toSafeNumber(args.timeoutMs);
  const deadlineAtMs = toSafeNumber(args.deadlineAtMs);
  // phase 1986 Step G：每次 exec 只授权调用者/subagent marker；
  // 宿主 allowlist、PATH 与 Windows 大小写统一由 ProcessExec 构造。
  const env: Record<string, string> = {
    [CALLER_AGENT_ID_ENV]: ctx.clawId,
    ...(ctx.subagentTaskId ? { CHESTNUT_SUBAGENT_TASK_ID: ctx.subagentTaskId } : {}),
  };
  return {
    command: args.command,
    cwd,
    timeoutMs,
    deadlineAtMs,
    env,
    stdin: args.stdin,
    onExecutionIdentity: args.onExecutionIdentity,
  };
}

const TRUNCATION_NOTICE = '\n[truncated]';
const PERSIST_FAILED_FOOTER = `${TRUNCATION_NOTICE}\n[full output persistence failed; no artifact was saved.]`;
const MIN_CLASSIFICATION_BYTES = 32;
const PREVIEW_HEAD_LIMIT = 600;
const PREVIEW_TAIL_LIMIT = 1400;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

/** Last guard for every createExecTool exit, including non-output rejections. */
function boundToolResult(result: ToolResult): ToolResult {
  return {
    ...result,
    content: utf8Bytes(result.content) > EXEC_MAX_OUTPUT
      ? truncateUtf8Prefix(result.content, EXEC_MAX_OUTPUT)
      : result.content,
    ...(utf8Bytes(result.content) > EXEC_MAX_OUTPUT || result.metadata?.output !== undefined
      ? {
          metadata: {
            ...result.metadata,
            output: result.metadata?.output ?? { ownerBounded: true },
          },
        }
      : result.metadata === undefined ? {} : { metadata: result.metadata }),
  };
}

function outputResult(
  success: boolean,
  content: string,
  artifact?: ToolResultArtifact,
): ToolResult {
  return boundToolResult({
    success,
    content,
    ...(artifact === undefined ? {} : {
      metadata: { output: { ownerBounded: true, artifact } },
    }),
  });
}

/** Fit a non-overflow output behind diagnostics; a long diagnostic is bounded too. */
function formatErrorContent(prefix: string, outputSuffix: string, output: string): string {
  const fixed = `${prefix}${outputSuffix}`;
  const fixedBytes = utf8Bytes(fixed);
  if (fixedBytes >= EXEC_MAX_OUTPUT) return truncateUtf8Prefix(fixed, EXEC_MAX_OUTPUT);
  const outputBudget = EXEC_MAX_OUTPUT - fixedBytes;
  if (utf8Bytes(output) <= outputBudget) return fixed + output;
  const noticeBytes = utf8Bytes(TRUNCATION_NOTICE);
  if (noticeBytes >= outputBudget) return fixed + truncateUtf8Prefix(output, outputBudget);
  return `${fixed}${truncateUtf8Prefix(output, outputBudget - noticeBytes)}${TRUNCATION_NOTICE}`;
}

// phase 524: HEAD/TAIL 常量 + truncateHeadTail 抽 foundation/file-tool/truncate-head-tail.ts。
// EXEC_MAX_OUTPUT === HEAD + TAIL = 2000B（业务 truncation 协议）。
// caller 均在 UTF-8 byte length > EXEC_MAX_OUTPUT 时调用、无需 helper 内重复阈值判。

function formatNoOutput(command: string): string {
  const short = command.length > EXEC_COMMAND_PLACEHOLDER_CHARS
    ? truncateUtf8Prefix(command, EXEC_COMMAND_PLACEHOLDER_CHARS) + '[truncated]'
    : command;
  return `(no output)\n[command]: ${short}`;
}

/**
 * Short, stable cleanup wording derived from structured L1 termination facts
 * (never parsed back out of error messages). Returns null when the error is
 * not a termination event (plain spawn error / natural non-zero exit).
 */
function formatTerminationCleanup(t: ExecutionTerminationFact): string {
  if (t.reason === 'not_started') return 'not_started';
  switch (t.status) {
    case 'gone':
      return t.killSent ? 'gone after SIGKILL' : 'gone after SIGTERM';
    case 'still_alive':
      return 'still_alive after SIGKILL';
    case 'indeterminate':
      return `indeterminate (${t.reason ?? 'unknown'})`;
  }
}

function auditExecTermination(ctx: ExecContext, t: ExecutionTerminationFact): void {
  ctx.auditWriter?.write(
    COMMAND_TOOL_AUDIT_EVENTS.EXEC_TERMINATION,
    `clawId=${ctx.clawId}`,
    `status=${t.status}`,
    `trigger=${t.trigger}`,
    `term_sent=${t.termSent}`,
    `kill_sent=${t.killSent}`,
    ...(t.identity !== undefined
      ? [`leader_pid=${t.identity.leaderPid}`, `process_group_id=${t.identity.processGroupId}`]
      : []),
    ...(t.reason !== undefined ? [`reason=${t.reason}`] : []),
  );
}

export async function processExecErrorToToolResult(
  error: ProcessExecError,
  command: string,
  ctx: ExecContext,
): Promise<ToolResult> {
  const isRealFailure = error.killed === true || error.exitCode === null;
  const short = command.length > EXEC_COMMAND_PLACEHOLDER_CHARS
    ? truncateUtf8Prefix(command, EXEC_COMMAND_PLACEHOLDER_CHARS) + '[truncated]'
    : command;

  if (error.maxBufferExceeded) {
    const overflows = utf8Bytes(error.output) > EXEC_MAX_OUTPUT;
    const prefix = overflows
      ? `Error: command output exceeded ${PROCESS_EXEC_DEFAULT_MAX_BUFFER / 1024 / 1024} MB limit.`
      : `Error: command output exceeded ${PROCESS_EXEC_DEFAULT_MAX_BUFFER / 1024 / 1024} MB limit. Use head/tail to truncate, or redirect to a file.`;
    return formatExecResult(ctx, error.output, {
      success: false,
      prefix,
      outputSuffix: overflows ? '\n[output]: ' : '\n[partial output]: ',
    });
  }

  if (isRealFailure) {
    const cleanupSuffix = error.termination !== undefined
      ? `\n[cleanup]: ${formatTerminationCleanup(error.termination)}`
      : '';
    const prefix = `Error: ${error.message}\n[command]: ${short}${cleanupSuffix}`;
    return formatExecResult(ctx, error.output, {
      success: false,
      prefix,
      outputSuffix: '\n[output]: ',
    });
  }

  // 纯非零退出码：command 自己语义信号、tool 已完成契约
  const prefix = `[exit ${error.exitCode}]\n[command]: ${short}`;
  return formatExecResult(ctx, error.output, {
    success: true,
    prefix,
    outputSuffix: '\n',
    emptyContent: `[exit ${error.exitCode}]\n${formatNoOutput(command)}`,
  });
}

type AtomicWriteResult = Awaited<ReturnType<ExecContext['fs']['writeAtomic']>>;

interface PersistedOverflow {
  relPath: string;
  fullPath: string;
  writeResult: AtomicWriteResult;
}

async function persistOverflow(
  ctx: ExecContext,
  output: string,
): Promise<PersistedOverflow | null> {
  try {
    const writeSide = ctx.toolOutput ?? ctx;
    const id = newShortUuid();
    // exec_overflow scratch 写到写侧 baseDir 下的 tasks/sync/exec/ 子目录。
    const relativePath = `${TASKS_SYNC_EXEC_DIR}/${id}.md`;
    const frontmatter = `---\nsource: exec_overflow\ncontent_length: ${output.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    const writeResult = await writeSide.fs.writeAtomic(relativePath, frontmatter + output);
    // Keep B7's baseDir-relative write; display/audit must resolve that same fixed artifact.
    const fullPath = path.join(ctx.toolOutput?.baseDir ?? ctx.clawDir, relativePath);
    const relPath = path.relative(writeSide.workspaceDir, fullPath);
    if (writeResult.kind !== 'durable') {
      ctx.auditWriter?.write(
        COMMAND_TOOL_AUDIT_EVENTS.OVERFLOW_PERSIST_FAILED,
        'stage=durability',
        `commit=${writeResult.kind}`,
        `path=${relPath}`,
        `reason=${formatErr(writeResult.error)}`,
      );
    }
    return { relPath, fullPath, writeResult };
  } catch (err) {
    ctx.auditWriter?.write(COMMAND_TOOL_AUDIT_EVENTS.OVERFLOW_PERSIST_FAILED, `reason=${formatErr(err)}`);
    return null;
  }
}

function formatPersistedFooter(output: string, persisted: PersistedOverflow): string {
  const preview = truncateHeadTail(output);
  const withPath = truncateHeadTail(output, persisted.relPath);
  const footer = withPath.slice(preview.length);
  if (persisted.writeResult.kind === 'durable') return footer;
  return `${footer}\n[artifact committed but durability unconfirmed: ${persisted.writeResult.kind}]` +
    `\n[reason]: ${formatErr(persisted.writeResult.error)}\n[path]: ${persisted.relPath}`;
}

/** Keep both ends of output while shrinking the existing 600/1400 preview to its final budget. */
function formatHeadTailPreview(output: string, budget: number): string {
  if (budget <= 0) return '';
  const original = truncateHeadTail(output);
  if (utf8Bytes(original) <= budget) return original;

  const bytes = Buffer.from(output, 'utf8');
  let headLimit = Math.min(PREVIEW_HEAD_LIMIT, Math.floor(budget * 0.3));
  let tailLimit = Math.min(PREVIEW_TAIL_LIMIT, budget - headLimit);
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = truncateUtf8Prefix(output, headLimit);
    const headBytes = utf8Bytes(head);
    let tailStart = Math.max(headBytes, bytes.length - tailLimit);
    while (tailStart < bytes.length && (bytes[tailStart]! & 0xc0) === 0x80) tailStart++;
    const tail = bytes.subarray(tailStart).toString('utf8');
    const truncatedBytes = bytes.length - headBytes - utf8Bytes(tail);
    const marker = `\n[...truncated ${truncatedBytes} bytes...]\n`;
    const candidate = `${head}${marker}${tail}`;
    if (utf8Bytes(candidate) <= budget) return candidate;
    const available = Math.max(0, budget - utf8Bytes(marker));
    headLimit = Math.min(PREVIEW_HEAD_LIMIT, Math.floor(available * 0.3));
    tailLimit = Math.min(PREVIEW_TAIL_LIMIT, available - headLimit);
  }
  return truncateUtf8Prefix(original, budget);
}

function artifactFor(persisted: PersistedOverflow): ToolResultArtifact {
  return { kind: persisted.writeResult.kind, path: persisted.relPath };
}

function fitOverflowContent(
  ctx: ExecContext,
  lead: string,
  output: string,
  persisted: PersistedOverflow | null,
): string {
  let footer = persisted === null ? PERSIST_FAILED_FOOTER : formatPersistedFooter(output, persisted);
  const minLeadBytes = Math.min(utf8Bytes(lead), MIN_CLASSIFICATION_BYTES);
  if (persisted !== null && utf8Bytes(footer) + minLeadBytes > EXEC_MAX_OUTPUT) {
    ctx.auditWriter?.write(
      COMMAND_TOOL_AUDIT_EVENTS.OVERFLOW_FOOTER_OMITTED,
      `path=${persisted.fullPath}`,
      `commit=${persisted.writeResult.kind}`,
      `reason=footer_exceeds_${EXEC_MAX_OUTPUT}_byte_budget`,
    );
    footer = `\n[full output saved; artifact=${persisted.writeResult.kind}; path omitted; see audit log.]`;
  }

  const leadBudget = EXEC_MAX_OUTPUT - utf8Bytes(footer);
  if (utf8Bytes(lead) >= leadBudget) {
    return truncateUtf8Prefix(lead, leadBudget) + footer;
  }
  return lead + formatHeadTailPreview(output, leadBudget - utf8Bytes(lead)) + footer;
}

interface ExecResultFormat {
  success: boolean;
  prefix?: string;
  outputSuffix?: string;
  emptyContent?: string;
}

/** Persist complete oversized output before constructing its bounded preview. */
async function formatExecResult(
  ctx: ExecContext,
  output: string,
  format: ExecResultFormat,
): Promise<ToolResult> {
  const lead = `${format.prefix ?? ''}${output ? (format.outputSuffix ?? '') : ''}`;
  if (!output) {
    const rawContent = format.emptyContent ?? format.prefix ?? '';
    if (utf8Bytes(rawContent) <= EXEC_MAX_OUTPUT) return outputResult(format.success, rawContent);
    const persisted = await persistOverflow(ctx, rawContent);
    return outputResult(
      persisted === null ? false : format.success,
      fitOverflowContent(ctx, '', rawContent, persisted),
      persisted === null ? { kind: 'failed' } : artifactFor(persisted),
    );
  }
  if (utf8Bytes(output) <= EXEC_MAX_OUTPUT) {
    const prefix = format.prefix ?? '';
    const outputSuffix = format.outputSuffix ?? '';
    const rawContent = `${prefix}${outputSuffix}${output}`;
    if (utf8Bytes(rawContent) <= EXEC_MAX_OUTPUT) {
      return outputResult(format.success, formatErrorContent(prefix, outputSuffix, output));
    }
    const persisted = await persistOverflow(ctx, rawContent);
    return outputResult(
      persisted === null ? false : format.success,
      fitOverflowContent(ctx, '', rawContent, persisted),
      persisted === null ? { kind: 'failed' } : artifactFor(persisted),
    );
  }

  const persisted = await persistOverflow(ctx, output);
  return outputResult(
    persisted === null ? false : format.success,
    fitOverflowContent(ctx, lead, output, persisted),
    persisted === null ? { kind: 'failed' } : artifactFor(persisted),
  );
}

/** Structured owner-bounded success result for createExecTool and the async wrapper. */
export async function formatExecOutputToolResult(
  ctx: ExecContext,
  output: string,
  command?: string,
): Promise<ToolResult> {
  return formatExecResult(ctx, output, {
    success: true,
    emptyContent: command === undefined ? '' : formatNoOutput(command),
  });
}

/** Compatibility content-only view; new callers should consume the ToolResult metadata. */
export async function formatExecOutputForToolResult(
  ctx: ExecContext,
  output: string,
): Promise<string> {
  return (await formatExecOutputToolResult(ctx, output)).content;
}

export const EXEC_TOOL_NAME = 'exec' as const;

export function createExecTool(preExecGuard?: PreExecGuard): Tool {
  const hostCommand = resolveHostCommand('');
  const description = `Execute a shell command in your clawspace. Runs via \`${hostCommand.invocation}\`; use commands and syntax supported by that interpreter, so shell features (pipes, redirects, quotes) work normally. Use powershell.exe -NoProfile -Command "..." when PowerShell is needed on Windows. Relative paths resolve against your clawspace.`;
  const commandDescription = 'Command string to execute using the syntax and commands supported by the host interpreter';

  return {
    name: EXEC_TOOL_NAME,
    profiles: ['full', 'subagent', 'miner'],
    description,
    schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: commandDescription,
        },
        cwd: {
          type: 'string',
          description: 'Working directory, relative to clawspace. Use ".." to escape clawspace to claw root (e.g. cwd: "../memory"). Default: clawspace.',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds (default ${COMMAND_TOOL_DEFAULT_TIMEOUT_MS})`,
        },
        stdin: {
          type: 'string',
          description: 'Content to pipe directly to the child process stdin; it is not parsed by the shell.',
        },
      },
      required: ['command'],
    },
    readonly: false,
    idempotent: false,
    defaultTimeoutMs: COMMAND_TOOL_DEFAULT_TIMEOUT_MS,
    // With at most one byte per newline, this finite line bound cannot tighten the byte contract.
    outputBounds: { maxBytes: EXEC_MAX_OUTPUT, maxLines: EXEC_MAX_OUTPUT + 1, artifactKind: 'exec' },

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const { command, cwd, timeoutMs, env, stdin } = resolveExecArgs({
        command: args.command as string,
        cwd: args.cwd as string | undefined,
        // phase 1472 Step B: agent 未传参时由 CommandTool own 默认值显式填（不依赖 L1 fallback）
        timeoutMs: (args.timeoutMs as number | undefined) ?? COMMAND_TOOL_DEFAULT_TIMEOUT_MS,
        stdin: args.stdin as string | undefined,
      }, ctx);

      if (preExecGuard) {
        const result = preExecGuard(command);
        if (!result.allow) {
          ctx.auditWriter?.write(
            COMMAND_TOOL_AUDIT_EVENTS.EXEC_GUARD_REJECTED,
            `clawId=${ctx.clawId}`,
            `guard_kind=${result.guardKind}`,
            `reason=${result.reason}`,
          );
          return formatExecResult(ctx, result.reason, { success: false });
        }
      }

      const longBlockingRejection = rejectLongBlockingExec(command, timeoutMs, ctx);
      if (longBlockingRejection) return boundToolResult(longBlockingRejection);

      // phase 1280: allow/deny reject 路径已 REFRAMED-OUT by-design 2026-05-25 user ratify
      // 未来 restriction 走 OS-level sandbox / 详 design §A.r136-cmd-tool-no-perm-mgmt-cleanup

      try {
        const hostCommand = resolveHostCommand(command);
        const result = await exec(hostCommand.executable, hostCommand.args, {
          cwd,
          timeout: timeoutMs,
          signal: ctx.signal,
          stdin,
          env,
        });

        // phase 1750 Step B: 成功路径截断协议内聚进公共 helper（与 async-exec-wrapper 单实现复用）
        return formatExecOutputToolResult(ctx, result.output, command);
      } catch (error) {
        // cwd hint 已删（phase: 心智收敛 workspace-relative / error 已含 LLM 自己的 tool_use，cwd 信息冗余）
        if (!(error instanceof ProcessExecError)) {
          return formatExecResult(ctx, `Error: ${formatErr(error)}`, { success: false });
        }

        // phase 1417 + phase 809: isRealFailure 判据单源在 processExecErrorToToolResult
        if (error.termination !== undefined) {
          auditExecTermination(ctx, error.termination);
        }
        return processExecErrorToToolResult(error, command, ctx);
      }
    },
  };
}

/**
 * Factory for a low-level exec helper that returns an ExecHandle instead of a
 * ToolResult. Reuses the same argument resolution (cwd, env, timeout) as
 * createExecTool, but returns the typed L1 handle for output, detach and
 * termination capabilities.
 */
export function createExecWithHandle(preExecGuard?: PreExecGuard) {
  return async function execWithHandleFn(
    args: ExecWithHandleArgs,
    ctx: ExecContext,
  ): Promise<ExecHandle> {
    const { command, cwd, timeoutMs, deadlineAtMs, env, stdin, onExecutionIdentity } = resolveExecArgs(args, ctx);

    if (preExecGuard) {
      const result = preExecGuard(command);
      if (!result.allow) {
        throw new Error(result.reason);
      }
    }

    // Runtime mirror of the type-level mutual exclusion: JS callers can
    // bypass the compile-time contract, and silently picking one policy by
    // priority would hide a caller bug (phase 1272 Step C).
    if (timeoutMs !== undefined && deadlineAtMs !== undefined) {
      throw new Error('timeoutMs and deadlineAtMs are mutually exclusive');
    }

    const hostCommand = resolveHostCommand(command);
    return execWithHandle(hostCommand.executable, hostCommand.args, {
      cwd,
      ...(deadlineAtMs !== undefined ? { deadlineAtMs } : { timeout: timeoutMs }),
      signal: ctx.signal,
      stdin,
      env,
      onExecutionIdentity,
    });
  };
}

/**
 * 创建 CommandTool 模块
 */
export function createCommandTools(preExecGuard?: PreExecGuard): { exec: import('../tools/index.js').Tool } {
  return { exec: createExecTool(preExecGuard) };
}
