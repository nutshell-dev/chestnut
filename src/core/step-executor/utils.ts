/**
 * @module L3.StepExecutor.Utils
 * Utility helpers — callback safety + content extraction + tool input parse
 */

import type { ContentBlock, ToolUseBlock, ToolResultBlock } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolUseId } from '../../foundation/llm-provider/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { STEP_EXECUTOR_AUDIT_EVENTS } from './audit-events.js';


/**
 * Execute a callback safely, swallowing errors to protect the executor loop.
 * Errors are logged and optionally forwarded via onSafeCallbackError for audit.
 * This resilience is intentional: callback failures must not break agent execution.
 */
export function safeCallback(
  label: string,
  fn: () => void,
  callbacks?: { onSafeCallbackError?: (label: string, err: unknown) => void },
  auditWriter?: AuditLog,
): void {
  try { fn(); }
  catch (err) {
    // silent: error forwarded via onSafeCallbackError callback (caller lifecycle audit)
    // phase 1812 Step B (SE-D5): 二级 reporter 受保护——reporter throw 不逃逸、
    // 不覆盖首错、不阻断后续 audit 留证；reporter 失败走零递归 console 边界，
    // 首错 / label / 二级 reporter error 三者均留证（不递归再报）。
    try {
      callbacks?.onSafeCallbackError?.(label, err);
    } catch (reportErr) {
      console.error( // console: 零递归 callback failure 边界——reporter 自身失败不能再走 audit/reporter（防递归），与 audit writer CRITICAL console 边界同决策
        `[STEP-EXECUTOR CALLBACK-REPORT-FAILED] label=${label} first=${formatErr(err)} report=${formatErr(reportErr)}`,
      );
    }
    auditWriter?.write(
      STEP_EXECUTOR_AUDIT_EVENTS.STEP_EXECUTOR_CALLBACK_FAILED,
      `label=${label}`,
      `error=${formatErr(err)}`,
    );
  }
}

type ParseToolInputResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; raw: string; error: string };

export function parseToolInput(raw: string, _toolName: string): ParseToolInputResult {
  try {
    return { ok: true, data: JSON.parse(raw || '{}') };
  } catch (err) {
    const errorMsg = formatErr(err);
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
    addedAt: new Date().toISOString(),
  });
}

export function appendToolResults(messages: Message[], results: ToolResultBlock[]): void {
  messages.push({
    role: 'user',
    content: results,
    addedAt: new Date().toISOString(),
    // 不填 origin：tool_result 既非 user 意图也非 system event、由 content block.type 区分
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
