/**
 * @module L5.EventLoop.StreamCallbacks
 * @layer L5 服务层
 * @depends L2.AuditLog, L2.Stream, L3.SubAgent（phase 1789 事件 owner）
 * @consumers L5.EventLoop
 *
 * 装配层：将 ReAct 循环业务事件名映射为 stream.jsonl 的 StreamEvent 记录。
 * phase 1856 (AE-D5): 返回型为 EventLoopStreamCallbacks —— 各段语义归 invoke owner
 * （stream 段 = AgentExecutor / turn+provider 生命周期 = Runtime / onTurnStart = EventLoop），
 * 本装配层只做组合、不再自 L3 整包引 StreamCallbacks。
 */

import type { StreamLog } from '../../foundation/stream/index.js';
import type { EventLoopStreamCallbacks, EventLoopTraceSource } from './types.js';
import type { ToolUseId } from '../../foundation/llm-provider/index.js';
import { STREAM_EVENT_NAMES } from '../../foundation/stream/index.js';
import { SUBAGENT_EVENTS } from '../subagent/index.js';
import { createSendContentTracker, feedSendContentDelta } from '../../foundation/messaging/index.js';


/**
 * 创建 StreamCallbacks 实现，将业务事件转为 StreamEvent 写入 StreamLog。
 * 装配层逻辑：ReAct 循环的业务事件名 → stream.jsonl 事件记录。
 */
export function createStreamCallbacks(
  sink: StreamLog,
  runtime: EventLoopTraceSource,
): EventLoopStreamCallbacks {
  const checkWrite = (event: import('../../foundation/stream/index.js').StreamEvent) => {
    const traceId = runtime.getCurrentTraceId();
    if (traceId) {
      (event as Record<string, unknown>).trace_id = traceId;
    }
    sink.write(event);
  };
  let sendTracker = createSendContentTracker();
  return {
    onBeforeLLMCall: () => {
      checkWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.LLM_START });
    },
    onThinkingDelta: (delta: string) => {
      checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.THINKING_DELTA, delta });
    },
    onTextDelta: (delta: string) => {
      checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.TEXT_DELTA, delta });
    },
    onTextEnd: () => {
      checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.TEXT_END });
    },
    onToolCall: (name: string, toolUseId: ToolUseId) => {
      if (name === 'send') sendTracker = createSendContentTracker();
      checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.TOOL_CALL, name, tool_use_id: toolUseId });
    },
    onToolUseInput: (name: string, toolUseId: ToolUseId, input: Record<string, unknown>) => {
      // phase 688: API 收到的 args body 必落 stream.jsonl（catch 路径 drain 时也走此回调）
      checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.TOOL_USE_INPUT, name, tool_use_id: toolUseId, input });
      if (name === 'send') {
        checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.SEND_CONTENT_END });
      }
    },
    onToolUseInputDelta: (name: string, _toolUseId: ToolUseId, partialInput: string) => {
      if (name !== 'send') return;
      const delta = feedSendContentDelta(sendTracker, partialInput);
      if (delta) {
        checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.SEND_CONTENT_DELTA, delta });
      }
    },
    onToolResult: (name: string, toolUseId: ToolUseId, result: { success: boolean; content: string }, step: number, maxSteps: number) => {
      const STREAM_SUMMARY_MAX_CHARS = 500;
      const content = (result.content ?? '').trimStart();
      const summary = content.length <= STREAM_SUMMARY_MAX_CHARS ? content : content.slice(0, STREAM_SUMMARY_MAX_CHARS) + '…';
      checkWrite({
        ts: Date.now(),
        type: SUBAGENT_EVENTS.TOOL_RESULT,
        name,
        tool_use_id: toolUseId,
        success: result.success,
        summary,
        step: step + 1,
        maxSteps,
      });
    },
    onTurnStart: (sources: Array<{ text: string; type: string }>) => {
      checkWrite({
        ts: Date.now(),
        type: SUBAGENT_EVENTS.TURN_START,
        sources: sources.length > 0 ? sources : undefined,
      });
    },
    onTurnEnd: () => {
      checkWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_END });
    },
    onTurnError: (error: string) => {
      checkWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_ERROR, error });
    },
    onTurnInterrupted: (cause: string, message?: string) => {
      checkWrite({ ts: Date.now(), type: SUBAGENT_EVENTS.TURN_INTERRUPTED, cause, ...(message ? { message } : {}) });
    },
    onProviderInfo: (info: { name: string; model: string; isFallback: boolean }) => {
      checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.PROVIDER_INFO, ...info });
    },
    onProviderFailover: (info: { from: string; timeoutMs: number }) => {
      checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.PROVIDER_FAILOVER, ...info });
    },
    onProviderFailed: (info: { provider: string; model: string; error: string }) => {
      // Phase 1176 Step C: 不再用正则 heuristic 伪造 provider_attempt_failed。
      // 结构化 owner event 已由 LLMOrchestrator → composite LLMEventSink 写入 stream。
      checkWrite({ ts: Date.now(), type: STREAM_EVENT_NAMES.PROVIDER_FAILED, ...info });
    },
  };
}
