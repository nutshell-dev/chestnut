import type { StreamEvent, StreamLog } from '../../foundation/stream/index.js';
import type { AuditArtifactRef, AuditLog, AuditLossRecord } from '../../foundation/audit/index.js';
import { encodeAuditArtifact, encodeAuditLoss } from '../../foundation/audit/index.js';
import { clipPreview, clipMessage, clipSummary } from '../../foundation/audit/index.js';
import type { SubAgentLifecycleSink } from './lifecycle-sink.js';

export class NoopStreamWriter implements StreamLog {
  write(_event: StreamEvent): boolean {
    return true;
  }
}

/**
 * phase 1858 Step K (SA-D10): lifecycle sink 面的 noop 实现（消费方/测试注入用）。
 * 语义与 NoopAuditWriter 一致：吞掉全部事件、零副作用。
 */
export class NoopLifecycleSink implements SubAgentLifecycleSink {
  turnStart(): void {}
  turnEnd(): void {}
  llmCall(_e: { model: string; inputTokens: number; outputTokens: number; latencyMs: number }): void {}
  llmError(_e: { model: string; error: string; latencyMs: number }): void {}
  turnInterrupted(_e: { cause: 'turn_timeout' | 'idle_timeout' | 'user_interrupt' | 'priority_inbox' | 'external'; ms?: number; type?: string }): void {}
  turnError(_e: { error: string }): void {}
  stepCompleteFailed(_e: { error: string }): void {}
  persistFailed(_e: { stage?: string; error: string }): void {}
  logAppendFailed(_e: { path: string; error: string }): void {}
  timeoutRejection(_e: { reason: string }): void {}
  ghostCallbackAfterTurnEnd(_e: { event: string }): void {}
  toolCallInput(_e: { name: string; toolUseId: string; step: number; argsSize: number }): void {}
  toolResult(_e: { name: string; toolUseId: string; step: number; success: boolean; content: string }): void {}
  partialAssistantDiscarded(_e: {
    cause: 'all_providers_failed' | 'idle_timeout' | 'unknown';
    toolUseCount: number;
    hasText: boolean;
    hasThinking: boolean;
    startTs: number;
    endTs: number;
    errMessage: string;
  }): void {}
  stepsInvariantViolated(_e: { kind: string; actual?: string; idx?: number }): void {}
  artifactCrossSourceOk(_e: { textEndCount: number; lastRole: string }): void {}
  artifactCrossSourceMismatch(_e: { textEndCount: number; lastRole: string }): void {}
  artifactCrossSourceSkipped(_e: { kind: string; reason: string; error: string }): void {}
  runReactAbortStillRunning(_e: { settleMs: number }): void {}
  captureProtocolMalformed(_e: { tool: string; reason: string }): void {}
  idleTimeoutCallbackFailed(_e: { error: string }): void {}
}

export class NoopAuditWriter implements AuditLog {
  readonly __brand = 'AuditLog' as const;
  private seq = 0; // NEW phase 1125 parity (即使 noop 也 increment 防 caller assert seq)

  write(_type: string, ..._cols: (string | number)[]): void {
    this.seq++;
  }

  preview(s: string): string { return clipPreview(s); }
  message(s: string): string { return clipMessage(s); }
  summary(s: string): string { return clipSummary(s); }
  artifact(ref: AuditArtifactRef): string[] { return encodeAuditArtifact(ref); }
  loss(record: AuditLossRecord): string[] { return encodeAuditLoss(record); }
}
