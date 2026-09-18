/**
 * @module L3.StepExecutor.CallerEventSink
 * @layer L3（caller adapter 惯例同 AE：协议在 L3、adapter 随协议模块出口、L4 组合使用）
 * @depends L2.AuditLog, L3.StepExecutor
 * @consumers L4.AgentExecutor
 *
 * phase 1857 Step I (SE-D9): StepExecutorEventSink → 展示（callbacks）+ 持久化
 * （audit 行）的 caller adapter。StepExecutor 只发结构化裁决事实一次；
 * contract_id/trace_id 身份绑定、列格式化与 message/preview 截断在本 adapter
 * 完成（审计行内容与原模块内直写逐列保持一致，等价矩阵锁定）。
 *
 * 实现契约（承接 SE-D4/SE-D6）：
 * - 展示调用经 safeCallback 守护（B 级：失败经 onSafeCallbackError 留证，不终止 step）；
 * - 持久化经 writeAuditGuarded（审计通道自身失败不抛出、不改变被记录的原失败）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import type { StepCallbacks } from './types.js';
import type { StepExecutorEventSink } from './audit-sink.js';
import { STEP_EXECUTOR_AUDIT_EVENTS } from './audit-events.js';
import { safeCallback, writeAuditGuarded } from './utils.js';

export function createStepExecutorEventSink(deps: {
  callbacks?: StepCallbacks;
  auditWriter?: AuditLog;
  /** contract 身份绑定（审计行 contract_id= 列；随 adapter deps 注入）。 */
  contractId?: string;
  traceId?: string;
}): StepExecutorEventSink {
  const { callbacks, auditWriter: aw, contractId, traceId } = deps;
  const traceCol = `trace_id=${traceId ?? ''}`;

  // 自引用：safeCallback 的 B 级留证经本 sink 的 callbackFailed 落 audit 行
  const sink: StepExecutorEventSink = {
    toolInputParseFailed: (e) => {
      safeCallback(
        'onToolInputParseError',
        () => callbacks?.onToolInputParseError?.(e.toolName, e.toolUseId as never, e.summary),
        callbacks,
        sink,
      );
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.TOOL_INPUT_PARSE_FAILED,
        e.toolName, e.toolUseId, `reason=${e.reason}`, `summary=${aw?.message(e.summary) ?? e.summary}`);
    },
    toolExecutionFailed: (e) => {
      safeCallback(
        'onToolExecutionFailed',
        () => callbacks?.onToolExecutionFailed?.(e.toolName, e.toolUseId as never, e.errorType, e.errorMsg),
        callbacks,
        sink,
      );
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.TOOL_EXECUTION_FAILED,
        e.toolName, e.toolUseId, `errorType=${e.errorType}`, `errorMsg=${aw?.message(e.errorMsg) ?? e.errorMsg}`);
    },
    partialAssistantDiscarded: (e) => {
      // 展示：同点一次（原 callback 载荷形态逐字段保持）
      safeCallback(
        'onPartialAssistantDiscarded',
        () => callbacks?.onPartialAssistantDiscarded?.({
          cause: e.cause as never,
          toolUseCount: e.toolUseCount,
          hasText: e.hasText,
          hasThinking: e.hasThinking,
          startTs: Number(e.tsRange.split('-')[0] ?? 0),
          endTs: Number(e.tsRange.split('-')[1] ?? 0),
          errMessage: e.errMessage,
        }),
        callbacks,
        sink,
      );
      // 持久化：列格式与原直写逐列一致（含 trace_id/contract_id 绑定）
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.PARTIAL_ASSISTANT_DISCARDED,
        `cause=${e.cause}`, `tool_use_count=${e.toolUseCount}`, `has_text=${e.hasText}`, `has_thinking=${e.hasThinking}`,
        `ts_range=${e.tsRange}`, traceCol, `contract_id=${contractId ?? ''}`,
        `err=${aw?.message(e.errMessage) ?? e.errMessage}`);
    },
    callbackFailed: (e) => {
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.STEP_EXECUTOR_CALLBACK_FAILED,
        `label=${e.label}`, `error=${e.error}`);
    },
    llmEmptyResponse: (e) => {
      safeCallback('onEmptyResponse', () => callbacks?.onEmptyResponse?.(e.stopReason), callbacks, sink);
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.LLM_EMPTY_RESPONSE, `stop_reason=${e.stopReason}`);
    },
    llmUnknownStopReason: (e) => {
      safeCallback('onUnknownStopReason', () => callbacks?.onUnknownStopReason?.(e.stopReason), callbacks, sink);
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.LLM_UNKNOWN_STOP_REASON, `stop_reason=${e.stopReason}`);
    },
    unparseableToolUse: (e) => {
      safeCallback('onUnparseableToolUse', () => callbacks?.onUnparseableToolUse?.(e.stopReason), callbacks, sink);
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.LLM_UNPARSEABLE_TOOL_USE, `stop_reason=${e.stopReason}`);
    },
    maxTokensAssistantEmptySkipped: (e) => {
      safeCallback(
        'onMaxTokensAssistantEmptySkipped',
        () => callbacks?.onMaxTokensAssistantEmptySkipped?.({ llm: e.llm }),
        callbacks,
        sink,
      );
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.MAX_TOKENS_ASSISTANT_EMPTY_SKIPPED, `model=${e.llm.model}`);
    },
    maxTokensStateAOrphanDrop: (e) => {
      // 展示一次（全量 orphans）；持久化按 orphan 逐行（列格式与原直写一致）
      safeCallback(
        'onMaxTokensStateAOrphanDrop',
        () => callbacks?.onMaxTokensStateAOrphanDrop?.({
          orphans: e.orphans.map(o => ({ tool_use_id: o.toolUseId, content: o.content, is_error: o.isError })),
          llm: e.llm,
        }),
        callbacks,
        sink,
      );
      for (const orphan of e.orphans) {
        writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.MAX_TOKENS_STATE_A_ORPHAN_DROP,
          `tool_use_id=${orphan.toolUseId}`, `is_error=${orphan.isError}`,
          `content_preview=${aw?.preview(orphan.content) ?? orphan.content}`, `model=${e.llm.model}`);
      }
    },
    maxTokensPrebuiltOnlyFinal: (e) => {
      safeCallback(
        'onMaxTokensPrebuiltOnlyFinal',
        () => callbacks?.onMaxTokensPrebuiltOnlyFinal?.({
          prebuiltCount: e.prebuiltCount,
          llm: e.llm,
        }),
        callbacks,
        sink,
      );
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.MAX_TOKENS_PREBUILT_ONLY_FINAL,
        `prebuilt_count=${e.prebuiltCount}`, `model=${e.llm.model}`);
    },
    invariantViolation: (e) => {
      const cols = [`site=${e.site}`, `kind=${e.kind}`];
      if (e.reason !== undefined) cols.push(`reason=${e.reason}`);
      if (e.index !== undefined) cols.push(`index=${e.index}`);
      cols.push(`msg=${e.msg}`);
      writeAuditGuarded(aw, STEP_EXECUTOR_AUDIT_EVENTS.INVARIANT_VIOLATION, ...cols);
    },
  };
  return sink;
}
