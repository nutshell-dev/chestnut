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

// ToolRegistry — canonical definition in tools/types.ts (L2c).
// Re-exported here for backward compat; remove post phase 2F.

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

// ExecContext 和 Tool 已迁至 L2c tools/types.ts。
// 上方重导出桥保持向后兼容，阶段二完成后移除。
