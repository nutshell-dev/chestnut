import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { Runtime } from '../runtime/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';
import type { UserActionHint } from '../../foundation/llm-orchestrator/index.js';

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
  runtime: Runtime;
  fsFactory: (baseDir: string) => FileSystem;
  agentDir: string;
  clawId: string;
  audit: AuditLog;
  inbox: { pendingDir: string; fallbackTimeoutMs?: number };
  streamWriter?: StreamWriter;
  onBatchComplete?: () => Promise<void>;
}
