import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { Runtime } from '../runtime/index.js';
import type { StreamWriter } from '../../foundation/stream/index.js';

export interface LLMRetryState {
  count: number;
  delayMs: number;
  pending: boolean;
}

export interface LoopErrorContext {
  audit: AuditLog;
  loopFs: FileSystem;
  llmRetry: LLMRetryState;
  saveLlmRetryState: () => void;
}

export interface EventLoopOptions {
  runtime: Runtime;
  agentDir: string;
  clawId: string;
  audit: AuditLog;
  inbox: { pendingDir: string; fallbackTimeoutMs?: number };
  streamWriter?: StreamWriter;
  onBatchComplete?: () => Promise<void>;
}
