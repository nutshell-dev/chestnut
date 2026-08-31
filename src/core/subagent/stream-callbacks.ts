/**
 * phase 1489: 提取 SubAgent.run() 内嵌的 stream/audit 双写回调工厂 + ghost-after-turn-end 守护。
 * derive M#1 — 流回调 / 超时 / 错误分类是独立可变方向。
 *
 * 行为契约：
 * - safeSwWrite: turnEnded 后写 → silent + emit GHOST_CALLBACK_AFTER_TURN_END (once per turn)
 * - callbacks 是 ReAct loop 接受的 7 个 primitive stream 回调（不含 resetIdle wrap / 不含 appendToLog / 不含 auditStepTools）
 *   - run() 调用方按需用箭头函数 wrap 这些 callback 注入 run-loop-local 副作用
 * - markTurnEnded / closeSw 各自管 turnEnded / swClosed 两个 closure flag
 *
 * tests/core/subagent.test.ts 含 ghost-after-turn-end 守护测试。
 */

import type { StreamEvent, StreamLog } from '../../foundation/stream/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { TraceId } from '../../foundation/audit/index.js';
import type { ToolUseId } from '../../foundation/llm-provider/index.js';
import { STREAM_EVENT_NAMES } from '../../foundation/stream/index.js';
import { STREAM_AGENT_EVENTS } from '../agent-executor/index.js';
import { SUBAGENT_AUDIT_EVENTS, emitToolCallInput } from './audit-events.js';
import { createSendContentTracker, feedSendContentDelta } from '../../foundation/messaging/index.js';



interface StreamCallbacksOptions {
  streamWriter: StreamLog;
  auditWriter: AuditLog;
  agentId: string;
  traceId: TraceId;
  currentContractId?: string;
}

export interface PrimitiveStreamCallbacks {
  onBeforeLLMCall: () => void;
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onTextEnd: () => void;
  onToolCall: (name: string, toolUseId: ToolUseId) => void;
  onToolCallInput: (name: string, toolUseId: ToolUseId, args: Record<string, unknown>, step: number) => void;
  /** phase 688: stream.jsonl 落 args body（catch 路径 drain 时也走此回调、API 输入不静默丢） */
  onToolUseInput: (name: string, toolUseId: ToolUseId, input: Record<string, unknown>) => void;
  /** phase 1180: raw partial JSON input on each tool_use_delta */
  onToolUseInputDelta: (name: string, toolUseId: ToolUseId, partialInput: string) => void;
  onToolResult: (
    name: string,
    toolUseId: ToolUseId,
    result: { success: boolean; content?: string },
    step: number,
    maxSteps: number,
  ) => void;
}

interface StreamCallbacksHandle {
  callbacks: PrimitiveStreamCallbacks;
  safeSwWrite: (event: StreamEvent) => void;
  closeSw: () => void;
  markTurnEnded: () => void;
  isTurnEnded: () => boolean;
}

export function createStreamCallbacks(opts: StreamCallbacksOptions): StreamCallbacksHandle {
  let turnEnded = false;
  let swClosed = false;
  let ghostAuditEmitted = false;
  let sendTracker = createSendContentTracker();

  const safeSwWrite = (event: StreamEvent) => {
    if (swClosed) {
      if (!ghostAuditEmitted) {
        ghostAuditEmitted = true;
        opts.auditWriter.write(
          SUBAGENT_AUDIT_EVENTS.GHOST_CALLBACK_AFTER_TURN_END,
          `agentId=${opts.agentId}`,
          `event=${event.type}`,
        );
      }
      return;
    }
    opts.streamWriter.write(event);
  };

  const callbacks: PrimitiveStreamCallbacks = {
    onBeforeLLMCall: () => {
      safeSwWrite({ ts: Date.now(), type: STREAM_AGENT_EVENTS.LLM_START });
    },
    onTextDelta: (delta) => {
      safeSwWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.TEXT_DELTA, delta });
    },
    onThinkingDelta: (delta) => {
      safeSwWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.THINKING_DELTA, delta });
    },
    onTextEnd: () => {
      safeSwWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.TEXT_END });
    },
    onToolCall: (name, toolUseId) => {
      if (name === 'send') sendTracker = createSendContentTracker();
      safeSwWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.TOOL_CALL, name, tool_use_id: toolUseId });
    },
    onToolCallInput: (name, toolUseId, args, step) => {
      // phase 1411 (reframe of phase 1409): typed emit `tool_call_input` index row；
      // step/contract/trace 均由 run boundary 提供真实值。
      // args body 0 入 audit / dialog/current.json 是全文权威源 / CLI 凭 tool_use_id join.
      const argsSize = JSON.stringify(args).length;
      emitToolCallInput(opts.auditWriter, {
        name,
        toolUseId,
        argsSize,
        step,
        contractId: opts.currentContractId,
        traceId: opts.traceId,
      });
    },
    onToolUseInput: (name, toolUseId, input) => {
      // phase 688: args body 落 stream.jsonl（流式产物全文契约）。
      // 与 onToolCallInput(audit only size) 互补：audit 仍只 index、stream.jsonl 才存 body。
      // catch 路径 drain 时也走此回调，确保 LLM 流中已 parse 的 input 不被静默丢弃。
      safeSwWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.TOOL_USE_INPUT, name, tool_use_id: toolUseId, input });
      if (name === 'send') {
        safeSwWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.SEND_CONTENT_END });
      }
    },
    onToolUseInputDelta: (name, _toolUseId, partialInput) => {
      if (name !== 'send') return;
      const delta = feedSendContentDelta(sendTracker, partialInput);
      if (delta) {
        safeSwWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.SEND_CONTENT_DELTA, delta });
      }
    },
    onToolResult: (name, toolUseId, result, step, maxSteps) => {
      const content = result.content ?? '';
      const preview = opts.auditWriter.summary(content);
      opts.auditWriter.write(
        SUBAGENT_AUDIT_EVENTS.TOOL_RESULT,
        name,
        `tool_use_id=${String(toolUseId)}`,
        `step=${step}`,
        `contract_id=${opts.currentContractId ?? ''}`,
        `trace_id=${opts.traceId}`,
        `status=${result.success ? 'ok' : 'err'}`,
        `content_size=${Buffer.byteLength(content, 'utf-8')}`,
        `summary=${preview}`,
      );
      safeSwWrite({
        ts: Date.now(),
        type: STREAM_AGENT_EVENTS.TOOL_RESULT,
        name,
        tool_use_id: toolUseId,
        success: result.success,
        summary: preview,
        step: step + 1,
        maxSteps,
      });
    },
  };

  return {
    callbacks,
    safeSwWrite,
    closeSw: () => { swClosed = true; },
    markTurnEnded: () => { turnEnded = true; },
    isTurnEnded: () => turnEnded,
  };
}
