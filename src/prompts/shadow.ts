/**
 * Shadow Default Wrapper Text
 *
 * phase 767 NEW
 * shadow 工具角色 wrapper 文本，shadow design plan D4 ratify。
 * Shadow wrapper 文本（phase 770 Form A 弃用后仅 Form B 用作合成 user message content）。
 * 文本不进系统提示词（C1 cache 命中保护），不可改 schema 字段（C2 cache 命中保护）。
 * 调整时确认是 const 文本变化（一次性影响后续所有 shadow，archive 不影响）。
 */


import type { ToolUseId } from '../foundation/tool-protocol/index.js';

export const SHADOW_INSTRUCTION_PREFIX = `[SHADOW INSTRUCTION — YOU ARE NO LONGER THE MAIN AGENT]`;

export interface BuildShadowInstructionArgs {
  shadowId: string;
  spawnedAt: string;
  spawnedByClawId: string;
  toolUseId: ToolUseId;
  task: string;
  /**
   * Shadow tool name (caller injected / phase 1306 DIP / 防 prompts/ 反向 import core/ 违 ML#5).
   * Caller (core/shadow-system/_helpers.ts) 传 SHADOW_TOOL_NAME from tools/shadow.
   */
  shadowToolName: string;
}

export function buildShadowInstruction(args: BuildShadowInstructionArgs): string {
  return `${SHADOW_INSTRUCTION_PREFIX}

Session metadata:
- role: shadow
- shadow_id: ${args.shadowId}
- spawned_at: ${args.spawnedAt}
- spawned_by: ${args.spawnedByClawId} at tool_use ${args.toolUseId}

You are a one-shot shadow of the main agent. Your conversation history is inherited
from the main agent up to this point. You have the same system prompt and tools as the
main agent. But you are NOT the main agent — you are a transient worker.

Constraints:
- You CANNOT call \`${args.shadowToolName}\` (no recursion). Calling shadow from within shadow will be rejected.
- You CAN call \`spawn\` but MUST set \`async=false\` (sync mode). spawn with \`async=true\` from within shadow will be rejected (async-scheduled tasks would orphan to main inbox after shadow exits).
- You CANNOT call \`summon\` (async-only routing, same orphan problem).

Task:
${args.task}

End your work by:
- Calling \`done(result="<final result>")\` (preferred, structured), OR
- Emitting a final assistant text with no further tool calls (fallback, text becomes result).

Important: Do NOT simulate what the shadow output "would be". You ARE the shadow.
Carry out the task directly.
`;
}
