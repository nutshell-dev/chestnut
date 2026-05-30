/**
 * @module L2.Messaging
 * phase 1469: Tool name typed const aggregate.
 *
 * 提供 motion guidance composer 编译期 check 工具名字面 typo / stale 工具名的 typed surface。
 * 配 invariant test enforce composer 输出文本内的已注册工具名字面必经此 const 引用。
 *
 * re-export 既有散落的 `*_TOOL_NAME` const 而非另立新名（DRY、避免命名漂移）。
 * 新工具加入时、同步 re-export 到此 surface。
 */

import { NOTIFY_CLAW_TOOL_NAME } from './tools/notify-claw.js';

export const TOOL_NAMES = {
  NOTIFY_CLAW: NOTIFY_CLAW_TOOL_NAME,
  // 待加入（phase γN 业主真 composer 需要时按需 import + re-export）：
  // SEND: SEND_TOOL_NAME（如 foundation/messaging/tools/send.ts export 此 const）
  // ASK_USER / DONE / SUBMIT_SUBTASK / SPAWN / SUMMON / ASK_MOTION / STATUS / SHADOW
  // READ / WRITE / EDIT / MULTI_EDIT / LS / SEARCH / MEMORY_SEARCH
} as const;

export type ToolName = typeof TOOL_NAMES[keyof typeof TOOL_NAMES];
