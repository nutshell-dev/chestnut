/**
 * @module L4.ContextManager
 * ContextManager typed errors
 *
 * Note on division of labour with LLMOrchestrator:
 * - LLMAllProvidersContextExceededError: Orchestrator has exhausted ALL providers and still over context limit.
 * - ContextTrimExhaustedError: a SINGLE provider has been trimmed to the bottom and still over limit.
 */

/**
 * phase 1861 (CM-D6)：ContextTrimExhaustedError 携带的恢复证据——
 * 消费方（Runtime/CLI/audit）从错误对象直接判因，不解析 message 文本。
 * 证据可得性如实：不可得字段由抛出点省略，不为填而填。
 */
import type { TrimPolicy } from './trim-v2.js';

export interface ContextTrimExhaustedEvidence {
  /** 裁剪后可用的消息预算（token）。 */
  budget: number;
  /** 触发的 provider/model（若可得）。 */
  provider?: string;
  /** 生效的裁剪策略（reactive/proactive 及其边界）。 */
  policy?: TrimPolicy;
}

export class ContextTrimExhaustedError extends Error {
  readonly name = 'ContextTrimExhaustedError';
  constructor(message: string, readonly evidence: ContextTrimExhaustedEvidence) {
    super(message);
  }
}
