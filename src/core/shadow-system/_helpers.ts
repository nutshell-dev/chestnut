/**
 * phase 767 NEW
 * Shadow session synthesis helper（phase 770 Form A 实证不可用，删 synthesizeFormA dead code）
 * phase 1115：phase 945 立的 3-turn 锚定撤回到 1-turn baseline（empirical refutation per `feedback_design_claim_requires_empirical_evidence`）
 * phase 1142：stripIncompleteToolUse mv from tools/shadow.ts → _helpers.ts、升 public export 作 L4 consumers（SummonSystem 契约创建子代理）复用 API。
 *
 * phase 1865 (SH-D10) 复用边界：本文件 primitives 是 Shadow 与 Summon 的唯一共享面——
 * 纯消息合成（stripIncompleteToolUse / synthesizeFormB），不共享业务状态。
 * 装配面（spawnShadowSubagent）的复用形态（继续复用 vs Summon 经 payload 契约自装配）
 * 归 1866 SU-D1 裁定；本 phase 只显式化 primitives 边界。
 */


import type { Message } from '../../foundation/dialog-store/index.js';
import { SHADOW_TOOL_NAME } from './constants.js';
import { buildShadowInstruction, type BuildShadowInstructionArgs } from '../../templates/prompts/index.js';

/**
 * Strip trailing incomplete assistant message so subagent LLM doesn't see unpaired tool_uses.
 * phase 1142 mv from tools/shadow.ts → _helpers.ts、升 public export 作 L4 consumers（SummonSystem 契约创建子代理）复用 API。
 *
 * phase 1865 (SH-D8) 输入不变量：仅用于快照副本——caller 的 main dialog 语义不得被本函数改变；
 * 本函数不变异输入（返回原数组或浅副本，元素只读不写入）。
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
