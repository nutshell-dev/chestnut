/**
 * phase 1858 Step K (SA-D10): SubAgent 最小结构化 lifecycle sink。
 *
 * 模块内 helpers 只消费本 sink（不再直接依赖完整 AuditLog）；真 AuditLog 的
 * 事件字符串 / 列格式 / 截断（summary/message）/ contract+trace+agentId 绑定由
 * adapter 侧保持（模式对齐 PM/DialogStore/StepExecutor owner-local sink）。
 *
 * 写失败策略（承 phase 1858 Step G):adapter 内守卫、stderr 最后手段、永不抛出——
 * 审计通道故障不改变执行结果。
 *
 * 不做：不合并 SUBAGENT_EVENTS（stream wire）与 audit 事件（不同协议）；
 *      不改事件字符串 / 列顺序 / 列名（等价矩阵 tests/core/subagent/lifecycle-sink-equivalence.test.ts 守）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import type { TraceId } from '../../foundation/audit/index.js';
import { clipMessage, clipSummary } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { SUBAGENT_AUDIT_EVENTS, REACT_LOOP_AUDIT_EVENTS } from './audit-events.js';

type PartialAssistantDiscardCause = 'all_providers_failed' | 'idle_timeout' | 'unknown';

export interface SubAgentLifecycleSink {
  // turn 生命周期（react-loop 事件族）
  turnStart(): void;
  turnEnd(): void;

  // LLM 调用
  llmCall(e: { model: string; inputTokens: number; outputTokens: number; latencyMs: number }): void;
  llmError(e: { model: string; error: string; latencyMs: number }): void;

  // 中断 / 错误分类
  turnInterrupted(e: {
    cause: 'turn_timeout' | 'idle_timeout' | 'user_interrupt' | 'priority_inbox' | 'external';
    ms?: number;
    type?: string;
  }): void;
  turnError(e: { error: string }): void;

  // 持久化 / 结算 / 超时
  stepCompleteFailed(e: { error: string }): void;
  persistFailed(e: { stage?: string; error: string }): void;
  logAppendFailed(e: { path: string; error: string }): void;
  timeoutRejection(e: { reason: string }): void;

  // stream 回调面
  ghostCallbackAfterTurnEnd(e: { event: string }): void;
  toolCallInput(e: { name: string; toolUseId: string; step: number; argsSize: number }): void;
  toolResult(e: { name: string; toolUseId: string; step: number; success: boolean; content: string }): void;
  partialAssistantDiscarded(e: {
    cause: PartialAssistantDiscardCause;
    toolUseCount: number;
    hasText: boolean;
    hasThinking: boolean;
    startTs: number;
    endTs: number;
    errMessage: string;
  }): void;

  // steps 形状不变量 / artifact 结算 / 协议登记
  stepsInvariantViolated(e: { kind: string; actual?: string; idx?: number }): void;
  artifactCrossSourceOk(e: { textEndCount: number; lastRole: string }): void;
  artifactCrossSourceMismatch(e: { textEndCount: number; lastRole: string }): void;
  artifactCrossSourceSkipped(e: { kind: string; reason: string; error: string }): void;
  runReactAbortStillRunning(e: { settleMs: number }): void;
  captureProtocolMalformed(e: { tool: string; reason: string }): void;
  idleTimeoutCallbackFailed(e: { error: string }): void;
}

/** invariants.ts 的 ISP 收窄消费面（仅需 steps 不变量写点）。 */
export type StepsInvariantSink = Pick<SubAgentLifecycleSink, 'stepsInvariantViolated'>;

export interface SubAgentLifecycleSinkOptions {
  auditWriter: AuditLog;
  agentId: string;
  traceId?: TraceId;
  currentContractId?: string;
}

/**
 * run helper（run.ts）构造的 adapter：真 AuditLog → 结构化 sink。
 * contract_id / trace_id / agentId 在此绑定（列值不受调用点影响）。
 */
export function createSubAgentLifecycleSink(opts: SubAgentLifecycleSinkOptions): SubAgentLifecycleSink {
  const { auditWriter, agentId } = opts;

  const write = (event: string, ...cols: (string | number)[]): void => {
    try {
      auditWriter.write(event, ...cols);
    } catch (auditErr) {
      process.stderr.write(`[subagent] audit write failed: ${event}: ${formatErr(auditErr)}\n`);
    }
  };

  return {
    turnStart: () => write(REACT_LOOP_AUDIT_EVENTS.TURN_START),
    turnEnd: () => write(REACT_LOOP_AUDIT_EVENTS.TURN_END),

    llmCall: (e) => write(
      REACT_LOOP_AUDIT_EVENTS.LLM_CALL,
      e.model, `in=${e.inputTokens}`, `out=${e.outputTokens}`, `latency_ms=${e.latencyMs}`,
    ),
    llmError: (e) => write(
      REACT_LOOP_AUDIT_EVENTS.LLM_ERROR,
      e.model, `error=${e.error}`, `latency_ms=${e.latencyMs}`,
    ),

    turnInterrupted: (e) => {
      if (e.cause === 'turn_timeout') {
        write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=turn_timeout', `turn_timeout_ms=${e.ms}`);
      } else if (e.cause === 'idle_timeout') {
        write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=idle_timeout', `idle_timeout_ms=${e.ms}`);
      } else if (e.cause === 'user_interrupt') {
        write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=user_interrupt');
      } else if (e.cause === 'priority_inbox') {
        write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=priority_inbox');
      } else {
        write(REACT_LOOP_AUDIT_EVENTS.TURN_INTERRUPTED, 'cause=external', ...(e.type ? [`type=${e.type}`] : []));
      }
    },
    turnError: (e) => write(REACT_LOOP_AUDIT_EVENTS.TURN_ERROR, `error=${e.error}`),

    stepCompleteFailed: (e) => write(
      SUBAGENT_AUDIT_EVENTS.STEP_COMPLETE_FAILED, `agentId=${agentId}`, `error=${e.error}`,
    ),
    persistFailed: (e) => write(
      SUBAGENT_AUDIT_EVENTS.PERSIST_FAILED,
      `agentId=${agentId}`,
      ...(e.stage ? [`stage=${e.stage}`] : []),
      `error=${e.error}`,
    ),
    logAppendFailed: (e) => write(
      SUBAGENT_AUDIT_EVENTS.LOG_APPEND_FAILED,
      `agentId=${agentId}`, `path=${e.path}`, `error=${e.error}`,
    ),
    timeoutRejection: (e) => write(
      SUBAGENT_AUDIT_EVENTS.TIMEOUT_REJECTION, `agentId=${agentId}`, `reason=${e.reason}`,
    ),

    ghostCallbackAfterTurnEnd: (e) => write(
      SUBAGENT_AUDIT_EVENTS.GHOST_CALLBACK_AFTER_TURN_END, `agentId=${agentId}`, `event=${e.event}`,
    ),
    toolCallInput: (e) => write(
      SUBAGENT_AUDIT_EVENTS.TOOL_CALL_INPUT,
      e.name,
      `tool_use_id=${String(e.toolUseId)}`,
      `step=${e.step}`,
      `contract_id=${opts.currentContractId ?? ''}`,
      `trace_id=${opts.traceId ?? ''}`,
      `args_size=${e.argsSize}`,
    ),
    toolResult: (e) => write(
      SUBAGENT_AUDIT_EVENTS.TOOL_RESULT,
      e.name,
      `tool_use_id=${String(e.toolUseId)}`,
      `step=${e.step}`,
      `contract_id=${opts.currentContractId ?? ''}`,
      `trace_id=${opts.traceId ?? ''}`,
      `status=${e.success ? 'ok' : 'err'}`,
      `content_size=${Buffer.byteLength(e.content, 'utf-8')}`,
      // clipSummary ≡ AuditLog.summary（同源截断常量）
      `summary=${clipSummary(e.content)}`,
    ),
    partialAssistantDiscarded: (e) => write(
      SUBAGENT_AUDIT_EVENTS.PARTIAL_ASSISTANT_DISCARDED,
      `cause=${e.cause}`,
      `tool_use_count=${e.toolUseCount}`,
      `has_text=${e.hasText}`,
      `has_thinking=${e.hasThinking}`,
      `ts_range=${e.startTs}-${e.endTs}`,
      // 忠实保留历史列值：该写点（phase 688 起）未传 traceId → 列为空
      `trace_id=`,
      `agent_id=${agentId}`,
      // clipMessage ≡ AuditLog.message（同源截断常量）
      `err=${clipMessage(e.errMessage)}`,
    ),

    stepsInvariantViolated: (e) => write(
      SUBAGENT_AUDIT_EVENTS.SUBAGENT_STEPS_INVARIANT_VIOLATED,
      `kind=${e.kind}`, `agentId=${agentId}`,
      ...(e.idx !== undefined ? [`idx=${e.idx}`] : []),
      ...(e.actual !== undefined ? [`actual=${e.actual}`] : []),
    ),
    artifactCrossSourceOk: (e) => write(
      SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_OK,
      `kind=ac4_ok`, `agentId=${agentId}`,
      `textend_count=${e.textEndCount}`, `last_role=${e.lastRole}`,
    ),
    artifactCrossSourceMismatch: (e) => write(
      SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_MISMATCH,
      `kind=ac4_textend_without_last_assistant_text`, `agentId=${agentId}`,
      `textend_count=${e.textEndCount}`, `last_role=${e.lastRole}`,
    ),
    artifactCrossSourceSkipped: (e) => write(
      SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_SKIPPED,
      `kind=${e.kind}`, `agentId=${agentId}`, `reason=${e.reason}`, `error=${e.error}`,
    ),
    runReactAbortStillRunning: (e) => write(
      SUBAGENT_AUDIT_EVENTS.RUNREACT_ABORT_STILL_RUNNING,
      `agentId=${agentId}`, `settle_ms=${e.settleMs}`,
    ),
    captureProtocolMalformed: (e) => write(
      SUBAGENT_AUDIT_EVENTS.CAPTURE_PROTOCOL_MALFORMED,
      `agentId=${agentId}`, `tool=${e.tool}`, `reason=${e.reason}`,
    ),
    idleTimeoutCallbackFailed: (e) => write(
      SUBAGENT_AUDIT_EVENTS.IDLE_TIMEOUT_CALLBACK_FAILED,
      `agentId=${agentId}`, `error=${e.error}`,
    ),
  };
}
