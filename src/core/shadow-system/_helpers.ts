/**
 * phase 767 NEW
 * Shadow session synthesis helper（phase 770 Form A 实证不可用，删 synthesizeFormA dead code）
 * phase 1115：phase 945 立的 3-turn 锚定撤回到 1-turn baseline（empirical refutation per `feedback_design_claim_requires_empirical_evidence`）
 */

import type { Message } from '../../foundation/llm-provider/types.js';
import { buildShadowInstruction, type BuildShadowInstructionArgs } from '../../prompts/index.js';

/**
 * Form B：shadow 专用前缀加新 user 消息
 * 主代理 session 末条 marker assistant 不进 shadow 视角
 * shadow 视角 prefix = 主会话 messages（excluding marker）加新 user message
 */
export function synthesizeFormB(args: {
  mainMessagesBeforeMarker: Message[];   // already sliced from ctx.dialogMessages
  instructionArgs: BuildShadowInstructionArgs;
}): Message[] {
  const instruction = buildShadowInstruction({ ...args.instructionArgs });
  return [
    ...args.mainMessagesBeforeMarker,
    { role: 'user', content: instruction },
  ];
}

export { formatErr } from '../../foundation/utils/format.js';
