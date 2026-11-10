/**
 * 公共恢复 owner 类型与请求身份工具。
 * 状态机主实现位于 recovery-ledger.ts；这里保留既有深导入兼容出口。
 */
import { sha256ShortHex } from '../node-utils/index.js';
import type {
  LLMCallOptions,
  LLMFailureDisposition,
  LLMInstanceSnapshot,
  LLMOrchestrator,
  LLMProbeResult,
  LLMRuntimeCapability,
} from './types.js';
import type { LLMRecoverySchedule } from './recovery-state.js';

export {
  LLMRecoveryControllerImpl,
  deriveLLMRecoverySchedule,
} from './recovery-ledger.js';
export type {
  LLMRecoveryAdmission,
  RecoveryFailureInput,
  RecoveryLedger,
  RecoveryLedgerDeps,
  RecoveryLedgerSnapshot,
} from './recovery-ledger.js';
// 深导入兼容出口；旧状态解释不进入公共 index barrel。
export { applyLegacyRecoveryRelease, deriveLegacyRecoverySchedule } from './legacy-recovery-compat.js';
export type { LegacyReleaseInput, LegacyReleaseResult } from './legacy-recovery-compat.js';

export interface LLMRecoverySignal {
  subscribeReady(listener: () => void): () => void;
  scheduleProbe(atMs: number): void;
}

export type SharedRecoveryDecision =
  | { kind: 'ready' }
  | { kind: 'at'; nextProbeAt: number }
  | { kind: 'on_change' };

/** 唯一真实 owner；所有直接注入方均通过其公共 call/stream 进入恢复。 */
export interface LLMOrchestratorOwner extends LLMOrchestrator, LLMRuntimeCapability, LLMRecoverySignal {
  healthCheck(): Promise<boolean>;
  isClosed(): boolean;
  inspectRecoverySchedule(): Promise<LLMRecoverySchedule>;
  snapshot(): LLMInstanceSnapshot;
  probe(): Promise<LLMProbeResult>;
  getSharedRecoveryDecision(): SharedRecoveryDecision;
  getFailureDisposition(error: unknown): LLMFailureDisposition;
  getProviderIdentities(): readonly string[];
  getLegacyProviderIdentities(): readonly string[];
}

export type { LLMRecoveryFacts } from './types.js';

/** 只由实际 LLM 请求语义派生身份；恢复事实、超时与 AbortSignal 不参与。 */
export function requestKeyForCall(options: LLMCallOptions): string {
  const canonical = canonicalizeForRequestKey({
    messages: options.messages,
    system: options.system,
    tools: options.tools,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    model: options.model,
  });
  return sha256ShortHex(JSON.stringify(canonical), 24);
}

function canonicalizeForRequestKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForRequestKey);
  if (typeof value !== 'object' || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) result[key] = canonicalizeForRequestKey(item);
  }
  return result;
}
