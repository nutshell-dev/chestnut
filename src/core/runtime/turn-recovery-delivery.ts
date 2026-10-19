/**
 * Phase 1955 Step C：StepExecutor 的 RecoveryDelivery 协议 → DialogStore
 * TurnRecoveryPersistence 的适配。归属 L5 Runtime（L3 协议与 L2 持久化之间），
 * 避免 L2 反向依赖 L3。
 */

import type { RecoveryDelivery } from '../step-executor/index.js';
import type { TurnRecoveryPersistence } from '../../foundation/dialog-store/index.js';

export function createTurnRecoveryDelivery(
  persistence: TurnRecoveryPersistence,
): RecoveryDelivery {
  return {
    async llmResponseCommitted(fact): Promise<void> {
      await persistence.recordLlmResponse({
        committedAtMs: fact.committedAtMs,
        stopReason: fact.response.stop_reason,
        content: fact.response.content,
      });
    },
    async toolStarted(fact): Promise<void> {
      await persistence.recordToolStarted({
        toolUseId: String(fact.toolUseId),
        toolName: fact.toolName,
        input: fact.input,
        startedAtMs: fact.startedAtMs,
      });
    },
    async toolResultCommitted(fact): Promise<void> {
      const content = fact.result.content;
      await persistence.recordToolResult({
        toolUseId: String(fact.toolUseId),
        toolName: fact.toolName,
        success: fact.result.success,
        ...(typeof content === 'string' ? { content } : {}),
        ...(fact.result.error !== undefined ? { error: fact.result.error } : {}),
        resultAtMs: fact.resultAtMs,
      });
    },
  };
}
