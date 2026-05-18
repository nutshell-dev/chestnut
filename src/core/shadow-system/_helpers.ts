/**
 * phase 767 NEW
 * Shadow session synthesis helper（phase 770 Form A 实证不可用，删 synthesizeFormA dead code）
 */

import type { Message } from '../../types/message.js';
import { buildShadowInstruction, buildShadowAckMessage, type BuildShadowInstructionArgs } from '../../prompts/index.js';

/**
 * Form B：shadow 专用前缀加新 user 消息
 * 主代理 session 末条 marker assistant 不进 shadow 视角
 * shadow 视角 prefix = 主会话 messages（excluding marker）加新 user message
 */
export function synthesizeFormB(args: {
  mainMessagesBeforeMarker: Message[];   // already sliced from ctx.dialogMessages
  instructionArgs: BuildShadowInstructionArgs;
}): Message[] {
  // phase 945 r118 B fork (audit-2026-05-14 P0.1 / 兑现 phase 775 γ 设计):
  // 3-turn 锚定 (user instruction + 合成 assistant ack + user "Proceed.")
  // 利用 LLM self-consistency bias、防 main agent Motion-voice 历史惯性覆盖 instruction
  const instruction = buildShadowInstruction({ ...args.instructionArgs });
  const ack = buildShadowAckMessage(args.instructionArgs.shadowId);
  return [
    ...args.mainMessagesBeforeMarker,
    { role: 'user', content: instruction },
    { role: 'assistant', content: ack },
    { role: 'user', content: 'Proceed.' },
  ];
}

export { formatErr } from '../../types/utils.js';
