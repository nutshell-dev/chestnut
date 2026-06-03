/**
 * @module L5.Runtime.ErrorResponse
 * @layer L5
 * Error/interrupt response handling for Runtime.
 *
 * Pure functions (no class state)、accepts AuditLog + OutboxWriter +
 * StreamCallbacks deps。
 *
 * phase 27 Step C: 从 runtime.ts 抽出（audit 报告 P3）。
 */

import { formatErr } from '../../foundation/utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { OutboxWriter } from '../../foundation/messaging/index.js';
import type { InboxMessage } from '../../foundation/messaging/types.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../signals.js';
import { REACT_LOOP_AUDIT_EVENTS, RUNTIME_AUDIT_EVENTS } from './runtime-audit-events.js';
import type { StreamCallbacks } from './types.js';

/**
 * 处理 turn 中断信号 (idle timeout / priority inbox / user interrupt) 或
 * 一般 error。同 runtime.ts:1093-1110 1:1 抽出。
 */
export function handleTurnInterrupt(
  err: unknown,
  audit: AuditLog,
  callbacks?: StreamCallbacks,
): void {
  if (err instanceof IdleTimeoutSignal) {
    const msg = `Interrupted (idle timeout: ${Math.round(err.timeoutMs / 1000)}s)`;
    callbacks?.onTurnInterrupted?.('idle_timeout', msg);
    audit.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=idle_timeout', `idle_timeout_ms=${err.timeoutMs}`);
  } else if (err instanceof PriorityInboxInterrupt) {
    callbacks?.onTurnInterrupted?.('priority_inbox', 'Interrupted (priority inbox)');
    audit.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=priority_inbox');
  } else if (err instanceof UserInterrupt) {
    callbacks?.onTurnInterrupted?.('user_interrupt');
    audit.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=user_interrupt');
  } else {
    const errorMsg = formatErr(err);
    callbacks?.onTurnError?.(errorMsg);
    audit.write(REACT_LOOP_AUDIT_EVENTS.TURN_ERROR, `error=${errorMsg}`);
  }
}

/**
 * 错误响应 outbox 写入 (max_steps_exhausted / non_interrupt_error)。
 * 同 runtime.ts:1119-1141 1:1 抽出。
 */
export async function writeErrorResponse(
  info: InboxMessage,
  errorMsg: string,
  scenario: 'max_steps_exhausted' | 'non_interrupt_error',
  audit: AuditLog,
  outbox: OutboxWriter,
): Promise<void> {
  const sender = info.from;
  if (!sender) return;

  await outbox.write({
    type: 'response',
    to: sender,
    content: `Error: ${errorMsg}`,
    metadata: info.metadata?.contract_id ? { contract_id: info.metadata.contract_id } : undefined,
  }).catch((e) => {
    const reason = formatErr(e);
    audit.write(
      RUNTIME_AUDIT_EVENTS.OUTBOX_WRITE_FAILED,
      'context=error_response',
      `scenario=${scenario}`,
      `reason=${reason}`,
    );
  });
}
