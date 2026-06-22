/**
 * @module L6.Daemon.StreamCallbacks
 * @layer L6 进程边界
 * @depends L2.AuditLog, L2.Stream, L5.Runtime
 * @consumers L6.DaemonLoop
 *
 * 装配层：将 ReAct 循环业务事件名映射为 stream.jsonl 的 StreamEvent 记录。
 */

import type { StreamLog } from '../foundation/stream/index.js';
import type { StreamCallbacks, Runtime } from '../core/runtime/index.js';
import type { ToolUseId } from '../foundation/tool-protocol/index.js';
import { AGENT_STREAM_EVENTS } from '../core/agent-executor/index.js';
import { clipText } from '../foundation/utils/index.js';

/**
 * 创建 StreamCallbacks 实现，将业务事件转为 StreamEvent 写入 StreamLog。
 * 装配层逻辑：ReAct 循环的业务事件名 → stream.jsonl 事件记录。
 */
export function createStreamCallbacks(
  sink: StreamLog,
  runtime: Runtime,
): StreamCallbacks {
  const checkWrite = (event: import('../foundation/stream/types.js').StreamEvent) => {
    const traceId = runtime.getCurrentTraceId();
    if (traceId) {
      (event as Record<string, unknown>).trace_id = traceId;
    }
    sink.write(event);
  };
  return {
    onBeforeLLMCall: () => {
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.LLM_START });
    },
    onThinkingDelta: (delta: string) => {
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.THINKING_DELTA, delta });
    },
    onTextDelta: (delta: string) => {
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TEXT_DELTA, delta });
    },
    onTextEnd: () => {
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TEXT_END });
    },
    onToolCall: (name: string, toolUseId: ToolUseId) => {
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TOOL_CALL, name, tool_use_id: toolUseId });
    },
    onToolUseInput: (name: string, toolUseId: ToolUseId, input: Record<string, unknown>) => {
      // phase 688: API 收到的 args body 必落 stream.jsonl（catch 路径 drain 时也走此回调）
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TOOL_USE_INPUT, name, tool_use_id: toolUseId, input });
    },
    onToolResult: (name: string, toolUseId: ToolUseId, result: { success: boolean; content: string }, step: number, maxSteps: number) => {
      const STREAM_SUMMARY_MAX_CHARS = 500;
      const summary = clipText(result.content, STREAM_SUMMARY_MAX_CHARS);
      checkWrite({
        ts: Date.now(),
        type: AGENT_STREAM_EVENTS.TOOL_RESULT,
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
        type: AGENT_STREAM_EVENTS.TURN_START,
        sources: sources.length > 0 ? sources : undefined,
      });
    },
    onTurnEnd: () => {
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_END });
    },
    onTurnError: (error: string) => {
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_ERROR, error });
    },
    onTurnInterrupted: (cause: string, message?: string) => {
      checkWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TURN_INTERRUPTED, cause, ...(message ? { message } : {}) });
    },
    onProviderInfo: (info: { name: string; model: string; isFallback: boolean }) => {
      checkWrite({ ts: Date.now(), type: 'provider_info', ...info });
    },
    onProviderFailover: (info: { from: string; timeoutMs: number }) => {
      checkWrite({ ts: Date.now(), type: 'provider_failover', ...info });
    },
    onProviderFailed: (info: { provider: string; model: string; error: string }) => {
      checkWrite({ ts: Date.now(), type: 'provider_failed', ...info });
      // Phase 737: heuristic permanent error detection for viewport banner
      const errorLower = info.error.toLowerCase();
      const isPermanent = /401|403|404|auth|quota|credit|insufficient|model not found|deprecated/.test(errorLower);
      if (isPermanent) {
        const hint = /quota|credit|insufficient/.test(errorLower)
          ? 'check_quota'
          : (/model|404/.test(errorLower) ? 'switch_primary' : 'rotate_api_key');
        checkWrite({
          ts: Date.now(),
          type: 'provider_attempt_failed',
          provider: info.provider,
          attempt: 0,
          error: info.error,
          errorClass: 'permanent',
          userActionHint: hint,
        });
      }
    },
  };
}
