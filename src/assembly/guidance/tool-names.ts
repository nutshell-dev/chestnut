/**
 * @module L6.Assembly.Guidance
 * phase 1469 立 / phase 1487 迁 L2 → L6: Tool name typed const aggregate.
 *
 * 提供 motion guidance composer 编译期 check 工具名字面 typo / stale 工具名的 typed surface。
 * 配 invariant test enforce composer 输出文本内的已注册工具名字面必经此 const 引用。
 *
 * re-export 各模块已 export 的 `*_TOOL_NAME` const（DRY、避免命名漂移）。
 * 物理迁 L2 → L6 原因（phase 1487 reframe）：
 *   - tool 实现物理分散 L1-L5（NOTIFY_CLAW L2 / SHADOW L4 / ...）
 *   - L2 re-export L4 const 违 ML#5（lower → higher）
 *   - composer 全在 L6 Assembly、TOOL_NAMES 是 composer 专用 surface
 *   - 迁 L6 后跨层 import 合规（L6 可下 import 任何层）
 */

import { NOTIFY_CLAW_TOOL_NAME } from '../../foundation/messaging/tools/notify-claw.js';
import { SHADOW_TOOL_NAME } from '../../core/shadow-system/constants.js';

export const TOOL_NAMES = {
  NOTIFY_CLAW: NOTIFY_CLAW_TOOL_NAME,
  SHADOW: SHADOW_TOOL_NAME,                  // phase 1487 γ5 contract-events composer 用
  // 待加入（phase γN 业主真 composer 需要时按需 import + re-export）：
  // SEND: SEND_TOOL_NAME（如 foundation/messaging/tools/send.ts export 此 const）
  // ASK_USER / DONE / SUBMIT_SUBTASK / SPAWN / SUMMON / ASK_MOTION / STATUS
  // READ / WRITE / EDIT / MULTI_EDIT / LS / SEARCH / MEMORY_SEARCH
} as const;

export type ToolName = typeof TOOL_NAMES[keyof typeof TOOL_NAMES];
