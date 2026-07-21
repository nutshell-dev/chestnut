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

export type ContextBlockedReason =
  | 'no_progress'
  | 'policy_conflict'
  | 'retry_exhausted';

interface ContextBlockedBase {
  version: 1;
  requestFingerprint: string;
  blockedAt: string;
}

export type ContextBlockedState =
  | (ContextBlockedBase & {
      reason: 'no_progress' | 'policy_conflict';
      before: number;
      after: number;
    })
  | (ContextBlockedBase & {
      reason: 'retry_exhausted';
      attempts: number;
      maxAttempts: number;
    });

export type ContextGateDecision =
  | { kind: 'open'; fingerprint: string }
  | { kind: 'released'; previous: ContextBlockedState; fingerprint: string }
  | { kind: 'blocked'; state: ContextBlockedState }
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
