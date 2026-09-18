/**
 * @module L3.StepExecutor.Utils
 * Utility helpers — callback safety + content extraction + tool input parse
 */

import type { ContentBlock, ToolUseBlock, ToolResultBlock } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ToolUseId } from '../../foundation/llm-provider/index.js';
import type { StepExecutorEventSink } from './audit-sink.js';


/**
 * phase 1857 Step E (SE-D4): 审计写失败不改变被记录的原失败。
 * 审计通道自身失败时唯一可用留证通道是 stderr（最后手段，非主通道）；
 * 本函数永不抛出。channel 缺失由调用点短路。
 * Step I 后归 caller adapter 的持久化侧使用（step-executor 内不再直写 audit）。
 */
export function writeAuditGuarded(
  sink: { write(event: string, ...details: (string | number)[]): void } | undefined,
  event: string,
  ...details: string[]
): void {
  if (!sink) return;
  try {
    sink.write(event, ...details);
  } catch (auditErr) {
    // 最后手段留证：审计通道自身失败，绝不能替代/遮蔽正在记录的原失败
    process.stderr.write(`[step-executor] audit write failed: ${event}: ${formatErr(auditErr)}\n`);
  }
}

/**
 * Execute a callback safely, swallowing errors to protect the executor loop.
 * Errors are logged and optionally forwarded via onSafeCallbackError for audit.
 * This resilience is intentional: callback failures must not break agent execution.
 *
 * phase 1857 Step I (SE-D9): B 级失败留证改经单一事件出口 sink.callbackFailed
 * （audit 行格式化归 caller adapter）。
 */
export function safeCallback(
  label: string,
  fn: () => void,
  callbacks?: { onSafeCallbackError?: (label: string, err: unknown) => void },
  eventSink?: StepExecutorEventSink,
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
    // SE-D4 语义保持：留证失败不得逃逸/改变原失败——实现契约要求 sink 不抛
    eventSink?.callbackFailed({ label, error: formatErr(err) });
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
