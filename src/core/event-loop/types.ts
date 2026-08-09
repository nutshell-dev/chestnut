import type { AuditLog, TraceId } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';
import type { UserActionHint } from '../../foundation/llm-orchestrator/index.js';
import type { InboxHandle } from '../../foundation/messaging/index.js';
import type { Message, ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { StreamCallbacks } from '../agent-executor/index.js';
import type { ContextTrimOutcome } from '../context_manager/index.js';
import type { TurnResult } from '../runtime/index.js';

/** Consumer-owned trace capability used by EventLoop stream projection. */
export interface EventLoopTraceSource {
  getCurrentTraceId(): TraceId | undefined;
}

/**
 * Runtime capability actually consumed by EventLoop.
 *
 * This interface deliberately lives with the consumer. Runtime satisfies it structurally;
 * EventLoop does not depend on the concrete Runtime class or expose fields it never reads.
 */
export interface EventLoopRuntime extends EventLoopTraceSource {
  abort(): void;
  ackHandles(handles: InboxHandle[], path: string): Promise<void>;
  nackHandles(handles: InboxHandle[], reason: string, path: string): Promise<void>;
  computeTurnRequestFingerprint(): Promise<string>;
  drainInbox(): Promise<{
    injected: Message[];
    sources: Array<{ text: string; type: string }>;
    count: number;
    addressedHandles: InboxHandle[];
  }>;
  getMessages(): Promise<Message[]>;
  getSystemPrompt(): Promise<string>;
  getToolsForLLM(): ToolDefinition[];
  proactiveTrimIfNeeded(
    messages: Message[],
    systemPrompt: string,
    toolsForLLM: ToolDefinition[],
  ): Promise<Message[]>;
  processTurn(
    messages: Message[],
    systemPrompt: string,
    toolsForLLM: ToolDefinition[],
    callbacks?: StreamCallbacks,
  ): Promise<TurnResult>;
  reactiveTrim(): Promise<ContextTrimOutcome>;
}

export interface LLMRetryState {
  count: number;
  delayMs: number;
  /** @deprecated P1-10: pending 字段已废弃，仅存于文件 schema 兼容。 */
  pending?: boolean;
}

/** Phase 1268 Step B: recoverable LLM 失败的错误分类（waiting 判别联合的合法值） */
export type RecoverableLLMErrorClass = 'transient' | 'rate_limit';

/**
 * Phase 1268 Step B: 已决定的 retry/cooldown 等待（schema v2 判别联合）。
 * 决定等待即先落盘；restart 按 resumeAt 恢复，不重新决策。
 * - retry: 普通退避重试，attempt 已消费（1-based），到期后允许下一次 drain。
 * - cooldown: 预算耗尽后的固定等待，attempts 保持 maxAttempts，到期只允许一次 probe。
 */
export type LLMRetryWaitingState =
  | {
      kind: 'retry';
      requestFingerprint: string;
      errorClass: RecoverableLLMErrorClass;
      attempt: number;
      maxAttempts: number;
      scheduledAt: string;
      resumeAt: string;
      error: string;
    }
  | {
      kind: 'cooldown';
      requestFingerprint: string;
      errorClass: RecoverableLLMErrorClass;
      attempts: number;
      maxAttempts: number;
      scheduledAt: string;
      resumeAt: string;
      error: string;
    };

export interface LoopErrorContext {
  audit: AuditLog;
  loopFs: FileSystem;
}

/**
 * Phase 1268 Step D: EventLoop-owned waiting 状态的结构化 stream 事件。
 * owner 只递交 presentation/recovery 所需字段（M#5/M#8）；
 * attempt 在 retry stage 为 1-based 已消费次数，cooldown stage 为耗尽 attempts。
 */
export type LLMRetryWaitingStreamAction = 'scheduled' | 'gated' | 'released';

export interface LLMRetryWaitingStreamEvent {
  ts: number;
  type: 'llm_retry_waiting';
  stage: 'retry' | 'cooldown';
  action: LLMRetryWaitingStreamAction;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  resumeAt: string;
  errorClass: RecoverableLLMErrorClass;
}

export type LLMRequestBlockedReason =
  | 'no_progress'
  | 'policy_conflict'
  | 'retry_exhausted'
  | 'invalid_request'
  | 'permanent_provider_error';

interface LLMRequestBlockedBase {
  version: 2;
  requestFingerprint: string;
  blockedAt: string;
}

export type LLMRequestBlockedState =
  | (LLMRequestBlockedBase & {
      reason: 'no_progress' | 'policy_conflict';
      before: number;
      after: number;
    })
  | (LLMRequestBlockedBase & {
      reason: 'retry_exhausted';
      attempts: number;
      maxAttempts: number;
    })
  | (LLMRequestBlockedBase & {
      reason: 'invalid_request';
      errorCode: 'LLM_INVALID_REQUEST';
    })
  | (LLMRequestBlockedBase & {
      reason: 'permanent_provider_error';
      userActionHint: UserActionHint;
      message: string;
    });

export type LLMRequestGateDecision =
  | { kind: 'open'; fingerprint: string }
  | { kind: 'released'; previous: LLMRequestBlockedState; fingerprint: string }
  | { kind: 'blocked'; state: LLMRequestBlockedState }
  | { kind: 'indeterminate'; error: import('../../foundation/messaging/index.js').PendingViewError };

export interface EventLoopOptions {
  runtime: EventLoopRuntime;
  fsFactory: (baseDir: string) => FileSystem;
  agentDir: string;
  clawId: string;
  audit: AuditLog;
  inbox: { pendingDir: string; fallbackTimeoutMs?: number };
  streamWriter?: StreamWriter;
  onBatchComplete?: () => Promise<void>;
}
