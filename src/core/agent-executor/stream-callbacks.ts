/**
 * @module L3.StreamCallbacks
 * AgentExecutor-owned stream callback protocol（仅本循环实际触发的面）。
 *
 * phase 729: moved out of runtime/types.ts so L3 AgentExecutor can reference
 * StreamCallbacks without creating a circular dependency with L5 Runtime.
 *
 * phase 1856 (AE-D5): 跨层语义回归 invoke owner —— turn 生命周期
 * （onTurnEnd/onTurnError/onTurnInterrupted → Runtime；onTurnStart → EventLoop）
 * 与 provider 生命周期（onProviderInfo/onProviderFailover/onProviderFailed → Runtime）
 * 不再由本协议持有；本接口只保留 AgentExecutor/StepExecutor 循环实际触发的
 * text/thinking/tool 流回调（consumer 组合最小 sink，见 runtime/turn-callbacks.ts
 * 与 event-loop/types.ts）。
 */

import type { ToolUseId } from '../../foundation/llm-provider/index.js';

export interface StreamCallbacks {
  onBeforeLLMCall?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: ToolUseId) => void;
  /** phase 688: tool_use args body 落 stream.jsonl（flushToolUse 成功 parse 后 fire） */
  onToolUseInput?: (toolName: string, toolUseId: ToolUseId, input: Record<string, unknown>) => void;
  /** phase 1180: raw partial JSON input on each tool_use_delta */
  onToolUseInputDelta?: (toolName: string, toolUseId: ToolUseId, partialInput: string) => void;
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: { success: boolean; content: string }, step: number, maxSteps: number) => void;
}
