/**
 * phase 1489: 提取 SubAgent.run() catch 块的 6 分支错误分类 + 双写（stream + audit）。
 * derive M#1 — 错误分类与流回调 / 超时是独立可变方向。
 *
 * 行为契约（与原 agent.ts:420-448 catch 块等价）：
 * - ToolTimeoutError       → TURN_INTERRUPTED + cause=turn_timeout + turn_timeout_ms
 * - StepAbortError(idle_timeout) → TURN_INTERRUPTED + cause=idle_timeout + idle_timeout_ms
 * - StepAbortError(user_interrupt) → TURN_INTERRUPTED + cause=user_interrupt
 * - StepAbortError(step_yield) → TURN_INTERRUPTED + cause=priority_inbox
 * - AbortError (external)  → TURN_INTERRUPTED + cause=external + (type=...) 可选
 * - 其它                    → TURN_ERROR + error=<msg>
 *
 * 调用方负责 rethrow + markTurnEnded + closeSw。本函数只 emit、不改控制流。
 */

import type { StreamEvent } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { ToolTimeoutError } from '../../foundation/tools/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { isStepAbortError } from '../step-executor/index.js';
import { ExternalAbortError } from '../../foundation/llm-provider/index.js';
import { SUBAGENT_EVENTS } from './stream-events.js';
import { REACT_LOOP_AUDIT_EVENTS } from './audit-events.js';

interface ClassifyErrorOptions {
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
    safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_INTERRUPTED, cause: 'turn_timeout', message: `Timeout after ${timeoutMs}ms` });
    auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=turn_timeout', `turn_timeout_ms=${timeoutMs}`);
  } else if (isStepAbortError(error)) {
    // phase 1857 Step B (SE-D1): 三信号 class 归一为 StepAbortError 数据协议载体
    if (error.reason.kind === 'idle_timeout') {
      safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_INTERRUPTED, cause: 'idle_timeout', message: `Idle timeout after ${error.reason.ms}ms` });
      auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=idle_timeout', `idle_timeout_ms=${error.reason.ms}`);
    } else if (error.reason.kind === 'user_interrupt') {
      safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_INTERRUPTED, cause: 'user_interrupt', message: 'User interrupt' });
      auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=user_interrupt');
    } else {
      safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_INTERRUPTED, cause: 'priority_inbox', message: 'Priority inbox' });
      auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=priority_inbox');
    }
  } else if (error instanceof ExternalAbortError) {
    const cause = error.abortReason;
    // phase 1802: abortReason 是 opaque evidence —— 结构提取 type（如有），不依赖 L1 枚举
    const causeType = cause && typeof cause === 'object' && 'type' in cause && typeof (cause as { type: unknown }).type === 'string'
      ? (cause as { type: string }).type : undefined;
    safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_INTERRUPTED, cause: 'external', message: errMsg });
    auditWriter.write(
      REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED,
      'cause=external',
      ...(causeType ? [`type=${causeType}`] : []),
    );
  } else {
    safeSwWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_ERROR, error: errMsg });
    auditWriter.write(REACT_LOOP_AUDIT_EVENTS.TURN_ERROR, `error=${errMsg}`);
  }
}
