/**
 * phase 767 NEW
 * Form A 加 Form B session synthesis helpers
 */

import type { Message } from '../../types/message.js';
import { buildShadowInstruction, type BuildShadowInstructionArgs } from '../../prompts/shadow.js';

/**
 * Form A：完全继承会话加 synthetic tool_result 配对补全
 * 主代理 session 末条是 assistant 含 shadow tool_use
 * shadow 视角 prefix = 主会话 messages 加合成 user tool_result
 */
export function synthesizeFormA(args: {
  mainMessages: Message[];   // includes marker assistant message at end
  toolUseId: string;
  instructionArgs: BuildShadowInstructionArgs;
}): Message[] {
  const instruction = buildShadowInstruction({ ...args.instructionArgs, form: 'A' });
  return [
    ...args.mainMessages,
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: args.toolUseId,
        content: instruction,
      }],
    },
  ];
}

/**
 * Form B：shadow 专用前缀加新 user 消息
 * 主代理 session 末条 marker assistant 不进 shadow 视角
 * shadow 视角 prefix = 主会话 messages（excluding marker）加新 user message
 */
export function synthesizeFormB(args: {
  mainMessagesBeforeMarker: Message[];   // already sliced by DialogStore.restoreBefore
  instructionArgs: BuildShadowInstructionArgs;
}): Message[] {
  const instruction = buildShadowInstruction({ ...args.instructionArgs, form: 'B' });
  return [
    ...args.mainMessagesBeforeMarker,
    {
      role: 'user',
      content: instruction,
    },
  ];
}

export function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
