/**
 * @module L3.StepExecutor.Utils
 * Utility helpers — callback safety + content extraction + tool input parse
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from '../../foundation/llm-provider/types.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';


/**
 * Execute a callback safely, swallowing errors to protect the executor loop.
 * Errors are logged and optionally forwarded via onSafeCallbackError for audit.
 * This resilience is intentional: callback failures must not break agent execution.
 */
export function safeCallback(
  label: string,
  fn: () => void,
  callbacks?: { onSafeCallbackError?: (label: string, err: unknown) => void },
): void {
  try { fn(); }
  catch (err) {
    // silent: error forwarded via onSafeCallbackError callback (caller lifecycle audit)
    callbacks?.onSafeCallbackError?.(label, err);
  }
}

export type ParseToolInputResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; raw: string; error: string };

export function parseToolInput(raw: string, _toolName: string): ParseToolInputResult {
  try {
    return { ok: true, data: JSON.parse(raw || '{}') };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, raw: raw ?? '', error: errorMsg };
  }
}

export function extractToolCalls(content: ContentBlock[]): ToolUseBlock[] {
  return content
    .filter((block): block is ToolUseBlock => block.type === 'tool_use')
    .map(block => ({
      type: 'tool_use',
      id: block.id,
      name: block.name,
      input: block.input as Record<string, unknown>,
    }));
}

export function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text'
    )
    .map(block => block.text)
    .join('')
    .trim();
}

export function appendAssistantMessage(messages: Message[], content: ContentBlock[]): void {
  messages.push({
    role: 'assistant',
    content,
  });
}

export function appendToolResults(messages: Message[], results: ToolResultBlock[]): void {
  messages.push({
    role: 'user',
    content: results,
  });
}

export function toToolResultBlock(toolUseId: ToolUseId, result: ToolResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: result.content,
    is_error: !result.success,
  };
}
