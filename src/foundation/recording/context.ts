import type { Message } from '../../types/message.js';
import type { AuditWriter } from '../audit/writer.js';

/**
 * stream.jsonl 写入接口（由 StreamWriter 结构兼容，无需 implements 声明）
 */
export interface StreamSink {
  write(event: { ts: number; type: string; [key: string]: unknown }): void;
}

/**
 * ReAct 循环的流式事件回调
 * daemon 专用的 onInboxMessages 在 core/runtime.ts 以扩展接口定义
 */
export interface StreamCallbacks {
  onBeforeLLMCall?: () => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: string) => void;
  onToolResult?: (toolName: string, toolUseId: string, result: { success: boolean; content: string }, step: number, maxSteps: number) => void;
  onTurnStart?: (sources: Array<{ text: string; type: string }>) => void;
  onTurnEnd?: () => void;
  onTurnError?: (error: string) => void;
  onTurnInterrupted?: (cause: string, message?: string) => void;
  onProviderInfo?: (info: { name: string; model: string; isFallback: boolean }) => void;
  /** Provider timed out mid-stream, failover starting */
  onProviderFailover?: (info: { from: string; timeoutMs: number }) => void;
}

/**
 * 统一记录上下文：daemon 和 in-process agent（subagent/dispatcher）共用
 *
 * Daemon:
 *   streamWriter → {agentDir}/stream.jsonl
 *   auditWriter  → {agentDir}/audit.tsv
 *   saveMessages → SessionManager.save()（dialog/current.json）
 *
 * SubAgent/Dispatcher:
 *   streamWriter → tasks/results/{taskId}/stream.jsonl
 *   auditWriter  → tasks/results/{taskId}/audit.tsv
 *   saveMessages → tasks/results/{taskId}/messages.json
 */
export interface RecordingContext {
  streamWriter: StreamSink;
  auditWriter: AuditWriter;
  saveMessages: (msgs: Message[]) => Promise<void>;
}
