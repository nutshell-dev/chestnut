/**
 * @module L3.StepExecutor.Utils
 * Utility helpers — callback safety + content extraction + tool input parse
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock } from '../../types/message.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { StepCallbacks } from './types.js';

export function safeCallback(label: string, fn: () => void): void {
  try { fn(); }
  catch (err) { console.warn(`[step-executor] ${label} error:`, err instanceof Error ? err.message : String(err)); }
}

export async function safeCallbackAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); }
  catch (err) { console.warn(`[step-executor] ${label} error:`, err instanceof Error ? err.message : String(err)); }
}

export function parseToolInput(raw: string, toolName: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error(`[step-executor] Failed to parse tool input for "${toolName}": ${err instanceof Error ? err.message : String(err)}`);
    return { __parseError: true, __raw: raw ?? '' };
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

export function toToolResultBlock(toolUseId: string, result: ToolResult): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: result.content,
    is_error: !result.success,
  };
}
