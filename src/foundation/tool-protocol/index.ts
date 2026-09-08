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
  ToolDescriptor,
  ToolResult,
  CallerSnapshot,
} from './types.js';
// ============================================================================
// phase 457: PermissionChecker barrel re-export (M#7 接口稳定 / barrel-only)
// 10 cross-module caller 走 barrel、不直 import permission.ts。
// ============================================================================

export type { PermissionChecker, GuardedWrite } from './permission.js';
