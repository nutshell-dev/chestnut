/**
 * phase 1489: 提取 SubAgent.run() 内嵌的 stream/audit 双写回调工厂 + ghost-after-turn-end 守护。
 * derive ML#1 — 流回调 / 超时 / 错误分类是独立可变方向。
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
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';
import { AGENT_STREAM_EVENTS } from '../agent-executor/index.js';
import { SUBAGENT_AUDIT_EVENTS, emitToolCallInput } from './audit-events.js';

import { oneLine } from '../../foundation/utils/index.js';

export interface StreamCallbacksOptions {
  streamWriter: StreamLog;
  auditWriter: AuditLog;
  agentId: string;
}

export interface PrimitiveStreamCallbacks {
  onBeforeLLMCall: () => void;
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onTextEnd: () => void;
  onToolCall: (name: string, toolUseId: ToolUseId) => void;
  onToolCallInput: (name: string, toolUseId: ToolUseId, args: Record<string, unknown>) => void;
  onToolResult: (
    name: string,
    toolUseId: ToolUseId,
    result: { success: boolean; content?: string },
    step: number,
    maxSteps: number,
  ) => void;
}

export interface StreamCallbacksHandle {
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
      safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.LLM_START });
    },
    onTextDelta: (delta) => {
      safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TEXT_DELTA, delta });
    },
    onThinkingDelta: (delta) => {
      safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.THINKING_DELTA, delta });
    },
    onTextEnd: () => {
      safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TEXT_END });
    },
    onToolCall: (name, toolUseId) => {
      safeSwWrite({ ts: Date.now(), type: AGENT_STREAM_EVENTS.TOOL_CALL, name, tool_use_id: toolUseId });
    },
    onToolCallInput: (name, toolUseId, args) => {
      // phase 1411 (reframe of phase 1409): typed emit `tool_call_input` index row.
      // args body 0 入 audit / dialog/current.json 是全文权威源 / CLI 凭 tool_use_id join.
      const argsSize = JSON.stringify(args).length;
      emitToolCallInput(opts.auditWriter, { name, toolUseId, argsSize, step: 0 });
    },
    onToolResult: (name, toolUseId, result, step, maxSteps) => {
      const content = result.content ?? '';
      const preview = oneLine(content);
      opts.auditWriter.write(
        SUBAGENT_AUDIT_EVENTS.TOOL_RESULT,
        name,
        `tool_use_id=${String(toolUseId)}`,
        `step=${step}`,
        `contract_id=`,
        `trace_id=`,
        `status=${result.success ? 'ok' : 'err'}`,
        `content_size=${Buffer.byteLength(content, 'utf-8')}`,
        `summary=${preview}`,
      );
      safeSwWrite({
        ts: Date.now(),
        type: AGENT_STREAM_EVENTS.TOOL_RESULT,
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
