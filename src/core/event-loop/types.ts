import type { AuditLog, TraceId } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';
import type { UserActionHint } from '../../foundation/llm-orchestrator/index.js';
import type { InboxHandle, InboxMessage } from '../../foundation/messaging/index.js';
import type { ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
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
  /** Phase 1153: 只读 pending 事实（准入前空工作检查）。 */
  peekPendingTurnFacts(): Promise<{ addressed: InboxMessage[]; controls: InboxMessage[] }>;
  /** Phase 1826: 尚未处理的用户干预身份（用户来源消息 id 列表，不透明）。 */
  peekPendingInterventionFacts(): Promise<{ userIds: string[] }>;
  /** Phase 1826: 等待期间的 Runtime 控制入口（应用最新配置并返回身份修订）。 */
  consumePendingControls(): Promise<{ consumed: number; configRevision?: string }>;
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

/** Phase 1268 Step B / phase 1776: recoverable LLM 失败的错误分类（waiting 判别联合的合法值）。quota = 配额时间窗类（EventLoop quota 退避，非配置类 permanent）。 */
export type RecoverableLLMErrorClass = 'transient' | 'rate_limit' | 'quota';

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
  signal?: AbortSignal;
}

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

/**
 * Phase 1396 Step E: Assembly 注入的执行停滞恢复依赖。
 * Phase 1840: 提醒链不再携带契约失败出口（failureSink 退役）；Assembly 只注入
 * 持久事实 probe 与 async-task 在途 probe。
 */
export interface EventLoopExecutionRecoveryDeps {
  /**
   * 读持久事实：本 claw 当前选中的 active contract + 最近一次持久 activity ts
   * （stream LLM output / contract 创建时间 merge）。activeContractId 存在时
   * lastActivityAt 必须非 null。
   * Phase 1841: probe 只给出当前选中的一个契约 ID（底层列表异常还可能折空）；
   * 未给出的 ID 不构成终态事实，不授权对其记录做任何清理。
   */
  probeActivity: () => Promise<{ activeContractId?: string; lastActivityAt: number | null }>;
  /** AsyncTaskSystem 在途 probe（async task 在途不得判 stall）。 */
  isAsyncTaskInFlight?: () => Promise<boolean>;
  /** 停滞判定超时（默认 EXECUTION_INACTIVITY_TIMEOUT_MS）。 */
  timeoutMs?: number;
}

export interface EventLoopOptions {
  runtime: EventLoopRuntime;
  fsFactory: (baseDir: string) => FileSystem;
  agentDir: string;
  clawId: string;
  audit: AuditLog;
  inbox: { pendingDir: string; fallbackTimeoutMs?: number };
  streamWriter?: StreamWriter;
  onBatchComplete?: () => Promise<void>;
  executionRecovery?: EventLoopExecutionRecoveryDeps;
  /**
   * Phase 1826: LLM 恢复安排 owner 的窄 capability（装配期注入）。
   * EventLoop 只消费 ready/at/on_change 与一次尝试准入；不注入时不做准入。
   */
  recovery?: import('../../foundation/llm-orchestrator/index.js').LLMRecoveryController;
}
