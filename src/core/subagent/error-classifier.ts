/**
 * phase 1489: 提取 SubAgent.run() catch 块的 6 分支错误分类 + 双写（stream + audit）。
 * derive ML#1 — 错误分类与流回调 / 超时是独立可变方向。
 *
 * 行为契约（与原 agent.ts:420-448 catch 块等价）：
 * - ToolTimeoutError       → TURN_INTERRUPTED + cause=turn_timeout + turn_timeout_ms
 * - IdleTimeoutSignal      → TURN_INTERRUPTED + cause=idle_timeout + idle_timeout_ms
 * - UserInterrupt          → TURN_INTERRUPTED + cause=user_interrupt
 * - PriorityInboxInterrupt → TURN_INTERRUPTED + cause=priority_inbox
 * - AbortError (external)  → TURN_INTERRUPTED + cause=external + (type=...) 可选
 * - 其它                    → TURN_ERROR + error=<msg>
 *
 * 调用方负责 rethrow + markTurnEnded + closeSw。本函数只 emit、不改控制流。
 */

import type { StreamEvent } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { ToolTimeoutError } from '../../foundation/errors.js';
import { formatErr } from '../../foundation/utils/index.js';
import { IdleTimeoutSignal, PriorityInboxInterrupt, UserInterrupt } from '../signals.js';
import type { AbortReason } from '../../foundation/llm-provider/index.js';
import { AGENT_STREAM_EVENTS } from '../agent-executor/index.js';
import { REACT_LOOP_AUDIT_EVENTS } from './audit-events.js';

export interface ClassifyErrorOptions {
  error: unknown;
  safeSwWrite: (event: StreamEvent) => void;
  auditWriter: AuditLog;
  /** turn-level timeout (ms)，用于 ToolTimeoutError 文案 + audit 字段 */
  timeoutMs: number;
}

export function classifyAndAuditError(opts: ClassifyErrorOptions): void {
  const { error, safeSwWrite, auditWriter, timeoutMs } = opts;
  const errMsg = formatErr(error);

  if (error instanceof ToolTimeoutError) {
    safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: `Timeout after ${timeoutMs}ms` });
    auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=turn_timeout', `turn_timeout_ms=${timeoutMs}`);
  } else if (error instanceof IdleTimeoutSignal) {
    safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: `Idle timeout after ${error.timeoutMs}ms` });
    auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=idle_timeout', `idle_timeout_ms=${error.timeoutMs}`);
  } else if (error instanceof UserInterrupt) {
    safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: 'User interrupt' });
    auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=user_interrupt');
  } else if (error instanceof PriorityInboxInterrupt) {
    safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: 'Priority inbox' });
    auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=priority_inbox');
  } else if ((error as Error)?.name === 'AbortError') {
    const cause = (error as Error & { cause?: AbortReason }).cause;
    safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, message: errMsg });
    auditWriter.write(
      REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED,
      'cause=external',
      ...(cause ? [`type=${cause.type}`] : []),
    );
  } else {
    safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_ERROR, error: errMsg });
    auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_ERROR, `error=${errMsg}`);
  }
}
