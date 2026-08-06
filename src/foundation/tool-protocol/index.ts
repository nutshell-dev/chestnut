/**
 * @module L2b.ToolProtocol
 * ToolProtocol module (L2) — LLM tool calling 协议 schema 单源
 *
 * arch §12: 「LLM 工具调用协议的 schema 抽象 / L2 LLM 语义基础设施 / 对接 LLM messages 中 tool_use/tool_result 协议 / 不知 chestnut 业务 / 是纯 LLM 协议层抽象」
 *
 * type-only / 无 runtime / 无 audit events
 */

export type {
  ToolProfile,
  JSONSchema7,
  ToolDescriptor,
  ToolResult,
  CallerSnapshot,
} from './types.js';

// ============================================================================
// phase 1358 立、phase 691 Step A 迁源：ToolUseId 物理 file 从 tool-protocol/tool-use-id.ts
// 迁到 llm-provider/tool-use-id.ts（canonical owner per declared SoT）、本 barrel re-export 保
// backward compat 表面、外部 caller 0 改动。
// ============================================================================

export type { ToolUseId } from '../llm-provider/index.js';
export { makeToolUseId } from '../llm-provider/index.js';

// ============================================================================
// phase 457: PermissionChecker barrel re-export (M#7 接口稳定 / barrel-only)
// 10 cross-module caller 走 barrel、不直 import permission.ts。
// ============================================================================

export type { PermissionChecker } from './permission.js';
