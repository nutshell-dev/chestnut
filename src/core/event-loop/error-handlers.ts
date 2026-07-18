/**
 * @module L5.EventLoop.ErrorHandlers
 * @layer L5 服务层
 * @depends L2.AuditLog, L1.FileSystem, L2.Messaging, L4.Runtime
 * @consumers L5.EventLoop
 *
 * EventLoop catch 块错误分类 handler 注册表。
 * 新增错误类型仅需加 entry、不改 catch 块本身（OCP）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { EVENTLOOP_AUDIT_EVENTS, LOOP_INTERRUPT_CAUSES } from './audit-events.js';
import {
  INTERRUPT_RECOVERY_DELAY_MS,
  LLM_MAX_RETRIES,
  LLM_RETRY_INITIAL_DELAY_MS,
  LLM_RETRY_MAX_DELAY_MS,
} from './constants.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../step-executor/signals.js';
import { LLMAllProvidersFailedError, isContextExceededError } from '../../foundation/llm-orchestrator/index.js';
import {
  MaxStepsExceededError,
  WallTimeExceededError,
  ConsecutiveParseErrorsExceededError,
  ConsecutiveMaxTokensToolUseError,
} from '../agent-executor/errors.js';
import { LockContentionExhaustedError } from '../contract/errors.js';

/**
 * EventLoop catch 块状态、handler 可读写以驱动 retry 状态机
 */
interface LoopErrorContext {
  audit: AuditLog;
  loopFs: FileSystem;
  llmRetry: {
    count: number;
    delayMs: number;
    pending: boolean;
  };
  saveLlmRetryState: () => void;
}

/**
 * ErrorHandler — 单一错误类型的处理策略
 * - match: 判该 err 是否本 handler 范畴
 * - handle: 执行 audit + recovery + state 变更
 *
 * 注册表按 match 顺序匹配、首个 match=true 即 handle 后返回
 */
interface ErrorHandler {
  name: string;
  match: (err: unknown, ctx: LoopErrorContext) => boolean;
  handle: (err: unknown, ctx: LoopErrorContext) => Promise<void>;
}

// ----- 5 handlers -----

const idleTimeoutHandler: ErrorHandler = {
  name: 'idle_timeout',
  match: (err) => err instanceof IdleTimeoutSignal,
  handle: async (_err, ctx) => {
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `cause=${LOOP_INTERRUPT_CAUSES.idle_timeout}`,
      `recovery_delay_ms=${INTERRUPT_RECOVERY_DELAY_MS}`,
    );
    await new Promise(resolve => setTimeout(resolve, INTERRUPT_RECOVERY_DELAY_MS));
  },
};

const userInterruptHandler: ErrorHandler = {
  name: 'user_interrupt',
  match: (err) => err instanceof UserInterrupt,
  handle: async (_err, ctx) => {
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `cause=${LOOP_INTERRUPT_CAUSES.user_interrupt}`,
    );
    // 不 waitForInbox — 直接返回让 while loop 下一轮立即调 drainInbox + processTurn，
    // 把被中断 turn 期间到达、仍残留在 inbox/pending 里的消息正常 drain 出来。
    // pending 真空时 drainInbox 返回 0 自然走正常 waitForInbox。
    // 与 priorityInboxHandler 保持一致。
  },
};

const priorityInboxHandler: ErrorHandler = {
  name: 'priority_inbox',
  match: (err) => err instanceof PriorityInboxInterrupt,
  handle: async (_err, ctx) => {
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `cause=${LOOP_INTERRUPT_CAUSES.priority_inbox}`,
      `recovery_delay_ms=0`,
    );
  },
};

const llmRetryHandler: ErrorHandler = {
  name: 'llm_retry',
  match: (err, ctx) =>
    (err instanceof LLMAllProvidersFailedError || isContextExceededError(err)) &&
    ctx.llmRetry.count < LLM_MAX_RETRIES,
  handle: async (err, ctx) => {
    ctx.llmRetry.count++;
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.LLM_RETRY,
      `attempt=${ctx.llmRetry.count}`,
      `max=${LLM_MAX_RETRIES}`,
      `delay_ms=${ctx.llmRetry.delayMs}`,
      `error=${(err as Error).message}`,
    );
    await new Promise(resolve => setTimeout(resolve, ctx.llmRetry.delayMs));
    ctx.llmRetry.delayMs = Math.min(ctx.llmRetry.delayMs * 2, LLM_RETRY_MAX_DELAY_MS);
    ctx.llmRetry.pending = true;
    ctx.saveLlmRetryState();
  },
};

const contextExceededExhaustedHandler: ErrorHandler = {
  name: 'context_exceeded_exhausted',
  match: (err) => isContextExceededError(err),
  handle: async (_err, ctx) => {
    ctx.llmRetry.count = 0;
    ctx.llmRetry.delayMs = LLM_RETRY_INITIAL_DELAY_MS;
    ctx.saveLlmRetryState();
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.COOLDOWN,
      `reason=context_exceeded_exhausted`,
      `cooldown_ms=${LLM_RETRY_MAX_DELAY_MS}`,
    );
    await new Promise(resolve => setTimeout(resolve, LLM_RETRY_MAX_DELAY_MS));
  },
};

/**
 * P0-2: 5 个确定性 typed Error 的统一 crash 分类源。
 * 注意 LLMAllProvidersFailedError 不在此列（transient 类、由 llmRetryHandler backoff 处理）。
 */
export function isAgentLoopCrashError(err: unknown): boolean {
  return err instanceof MaxStepsExceededError
      || err instanceof WallTimeExceededError
      || err instanceof ConsecutiveParseErrorsExceededError
      || err instanceof ConsecutiveMaxTokensToolUseError
      || err instanceof LockContentionExhaustedError;
}

const agentLoopCrashHandler: ErrorHandler = {
  name: 'agent_loop_crash',
  match: (err) => isAgentLoopCrashError(err),
  handle: async (err, ctx) => {
    ctx.llmRetry.count = 0;
    ctx.llmRetry.delayMs = LLM_RETRY_INITIAL_DELAY_MS;
    ctx.saveLlmRetryState();
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.FATAL,
      `reason=agent_loop_crash`,
      `error=${formatErr(err)}`,
    );
  },
};

const fallbackHandler: ErrorHandler = {
  name: 'fatal_fallback',
  match: () => true,  // 兜底
  handle: async (err, ctx) => {
    const isLLMMaxRetry = err instanceof LLMAllProvidersFailedError;
    ctx.llmRetry.count = 0;
    ctx.llmRetry.delayMs = LLM_RETRY_INITIAL_DELAY_MS;
    ctx.saveLlmRetryState();
    ctx.audit.write(
      EVENTLOOP_AUDIT_EVENTS.FATAL,
      `reason=${isLLMMaxRetry ? 'max_retries_exhausted' : 'non_llm_error'}`,
      `error=${formatErr(err)}`,
    );
    // 不 waitForInbox — 直接返回让 while loop 下一轮立即调 drainInbox + processTurn，
    // 把 nack 回 inbox/pending 的消息正常 drain 出来。
    // pending 真空时 drainInbox 返回 0 自然走正常 waitForInbox。
    // 与 userInterruptHandler / priorityInboxHandler 保持一致。
  },
};

export const ERROR_HANDLERS: ReadonlyArray<ErrorHandler> = [
  idleTimeoutHandler,
  userInterruptHandler,
  priorityInboxHandler,
  llmRetryHandler,
  contextExceededExhaustedHandler,
  agentLoopCrashHandler,
  fallbackHandler,
];

export async function dispatchError(err: unknown, ctx: LoopErrorContext): Promise<void> {
  for (const handler of ERROR_HANDLERS) {
    if (handler.match(err, ctx)) {
      await handler.handle(err, ctx);
      return;
    }
  }
  // 兜底永远 match、不应到这
  throw new Error('Unreachable: fallback handler should match all errors');
}
