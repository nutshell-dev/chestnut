/**
 * @module Core.StreamCallbacks
 * Cross-cutting stream callback types used by Runtime, AgentExecutor and Daemon.
 *
 * phase 729: moved out of runtime/types.ts so L3 AgentExecutor can reference
 * StreamCallbacks without creating a circular dependency with L5 Runtime.
 */

import type { ToolUseId } from '../foundation/tool-protocol/index.js';

export interface StreamCallbacks {
  onBeforeLLMCall?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: ToolUseId) => void;
  /** phase 688: tool_use args body 落 stream.jsonl（flushToolUse 成功 parse 后 fire） */
  onToolUseInput?: (toolName: string, toolUseId: ToolUseId, input: Record<string, unknown>) => void;
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: { success: boolean; content: string }, step: number, maxSteps: number) => void;
  onTurnStart?: (sources: Array<{ text: string; type: string }>) => void;
  onTurnEnd?: () => void;
  onTurnError?: (error: string) => void;
  onTurnInterrupted?: (cause: string, message?: string) => void;
  onProviderInfo?: (info: { name: string; model: string; isFallback: boolean }) => void;
  /** Provider timed out mid-stream, failover starting */
  onProviderFailover?: (info: { from: string; timeoutMs: number }) => void;
  /** Provider failed, failover continuing to next provider */
  onProviderFailed?: (info: { provider: string; model: string; error: string }) => void;
}

export interface DaemonStreamCallbacks extends StreamCallbacks {
  onInboxMessages?: (messages: import('../foundation/messaging/index.js').InboxMessage[]) => Promise<void>;
}
