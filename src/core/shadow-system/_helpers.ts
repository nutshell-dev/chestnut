/**
 * phase 767 NEW
 * Shadow session synthesis helper（phase 770 Form A 实证不可用，删 synthesizeFormA dead code）
 * phase 1115：phase 945 立的 3-turn 锚定撤回到 1-turn baseline（empirical refutation per `feedback_design_claim_requires_empirical_evidence`）
 * phase 1142：stripIncompleteToolUse mv from tools/shadow.ts → _helpers.ts、升 public export 作 L4 consumers (SummonSystem) 复用 API。
 */

import type { Message } from '../../foundation/llm-provider/types.js';
import { SHADOW_TOOL_NAME } from './constants.js';
import { buildShadowInstruction, type BuildShadowInstructionArgs } from '../../templates/prompts/index.js';

/**
 * Strip trailing incomplete assistant message so subagent LLM doesn't see unpaired tool_uses.
 * phase 1142 mv from tools/shadow.ts → _helpers.ts、升 public export 作 L4 consumers (SummonSystem) 复用 API。
 */
export function stripIncompleteToolUse(msgs: Message[] | undefined): Message[] | undefined {
  if (!msgs || msgs.length === 0) return msgs;
  const last = msgs[msgs.length - 1];
  if (last.role === 'assistant' && Array.isArray(last.content)) {
    if (last.content.some((block: unknown) => (block as { type?: string })?.type === 'tool_use')) {
      return msgs.slice(0, -1);
    }
  }
  return msgs;
}

/**
 * Form B：shadow 专用前缀加新 user 消息
 * 主代理 session 末条 marker assistant 不进 shadow 视角
 * shadow 视角 prefix = 主会话 messages（excluding marker）加新 user message
 */
export function synthesizeFormB(args: {
  mainMessagesBeforeMarker: Message[];   // already sliced from ctx.dialogMessages
  instructionArgs: Omit<BuildShadowInstructionArgs, 'shadowToolName'>;
}): Message[] {
  const instruction = buildShadowInstruction({
    ...args.instructionArgs,
    shadowToolName: SHADOW_TOOL_NAME,
  } as BuildShadowInstructionArgs);
  return [
    ...args.mainMessagesBeforeMarker,
    { role: 'user', content: instruction },
  ];
}

export { formatErr } from '../../foundation/utils/format.js';
