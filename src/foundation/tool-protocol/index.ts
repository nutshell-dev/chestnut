/**
 * @module L2.ToolProtocol
 * ToolProtocol module (L2) — LLM tool calling 协议 schema 单源
 *
 * arch §12: 「LLM 工具调用协议的 schema 抽象 / L2 LLM 语义基础设施 / 对接 LLM messages 中 tool_use/tool_result 协议 / 不知 clawforum 业务 / 是纯 LLM 协议层抽象」
 *
 * type-only / 无 runtime / 无 audit events
 */

import type { JSONSchema7 } from '../llm-provider/types.js';
export type ToolProfile = string;
export type { JSONSchema7 };

// Tool、ExecContext、ToolRegistry 已迁至 L2c tools/types.ts。
// 消费方请直接从 foundation/tools/index.js 导入。

/**
 * Tool descriptor — pure LLM-facing protocol skeleton.
 *
 * What the LLM sees when it receives the tool list. This is the only type
 * ToolProtocol (L2b) owns: the shape that bridges LLM tool_use protocol
 * and clawforum's internal tool execution.
 *
 * L2c Tools converts Tool → { name, description, input_schema } via
 * formatForLLM().
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  schema: JSONSchema7;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: {
    filesAffected?: string[];
    durationMs?: number;
    [key: string]: unknown;
  };
}

// ============================================================================
// phase 1358: ToolUseId branded type (compile-time ID discrimination)
// ============================================================================

declare const ToolUseIdBrand: unique symbol;
export type ToolUseId = string & { readonly [ToolUseIdBrand]: true };
export function makeToolUseId(s: string): ToolUseId { return s as ToolUseId; }

// ============================================================================
// phase 1406: CallerSnapshot — caller deep context shape (lazy / declared opt-in)
// ============================================================================

import type { Message, ToolDefinition } from '../llm-provider/types.js';

/**
 * Caller deep context snapshot — system prompt + tool list + dialog messages.
 *
 * Type-only schema. Provided by ExecContext.getCallerSnapshot() when bound
 * by Assembly / Claw at construction time. Lazy: not materialized until called.
 *
 * Access gate: only tools declaring `accessesCaller: true` are allowed
 * to invoke getCallerSnapshot(); ToolExecutor wraps and audit-emits otherwise.
 */
export interface CallerSnapshot {
  /** Caller's current system prompt (Prompt module output). */
  systemPrompt: string;
  /** Caller's full tool list (LLM-facing definitions, profile-filtered). */
  tools: ToolDefinition[];
  /** Caller's current turn dialog messages. */
  messages: Message[];
}
