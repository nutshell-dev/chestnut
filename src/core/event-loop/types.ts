import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { Runtime } from '../runtime/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';

export interface LLMRetryState {
  count: number;
  delayMs: number;
  /** @deprecated P1-10: pending 字段已废弃，仅存于文件 schema 兼容。 */
  pending?: boolean;
}

export interface LoopErrorContext {
  audit: AuditLog;
  loopFs: FileSystem;
  llmRetry: LLMRetryState;
  saveLlmRetryState: () => void;
}

export type LLMRequestBlockedReason =
  | 'no_progress'
  | 'policy_conflict'
  | 'retry_exhausted'
  | 'invalid_request';

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
