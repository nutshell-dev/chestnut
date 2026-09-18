/**
 * @module L4.ShadowSystem.SpawnShadowSubagent
 * @layer L4
 * @depends L4.AsyncTaskSystem.schedule, L4.ShadowSystem._helpers (synthesizeFormB), L2.Prompts (buildShadowInstruction)
 *
 * 装配 shadow subagent task 唯一入口 (M#1 + M#2 + M#3 align)。
 *
 * phase 1185 derive：phase 1142 升 SHADOW INSTRUCTION primitives 为 public 但「装配组合」散落 shadow.ts + summon.ts、
 * 真 production 双 push bug 实证、M#11「停下来重构」兑现。
 */

import { buildShadowPayload } from './payload.js';
import type { SpawnShadowSubagentOptions, SpawnShadowSubagentResult } from './types.js';
import { makeShortTaskId } from '../async-task-system/index.js';

/**
 * Default max steps for shadow subagent execution（agent loop iteration cap）.
 * Derivation: 100 step ≈ shadow 派生子代理足够完成「契约创建」类 reasoning / 比
 * DEFAULT_MAX_STEPS (1000) 紧 10× 因 shadow 任务限定明确 / 防 runaway loop 浪费 token.
 */
const SHADOW_MAX_STEPS_DEFAULT = 100;
import { SHADOW_DEFAULT_TIMEOUT_MS } from './constants.js';



export async function spawnShadowSubagent(
  opts: SpawnShadowSubagentOptions,
): Promise<SpawnShadowSubagentResult> {
  if (!opts.taskSystem) {
    return {
      success: false,
      content: '[shadow spawn] task_system not available in execution context — shadow path requires AsyncTaskSystem injection',
      error: 'task_system_unavailable',
    };
  }

  // phase 1865 (SH-D1)：payload 构造归 owner（buildShadowPayload），此处只做 schedule 平铺映射（1:1）。
  const payload = buildShadowPayload(opts);

  // phase 1865 (SH-D4)：detached 不继承 caller signal——语义已进契约面（payload.detached，
  // ratify 链见 SpawnShadowSubagentOptions JSDoc）；本处行为不变。
  const taskId = await opts.taskSystem.schedule('subagent', {
    kind: 'subagent',
    mode: 'shadow',                            // δ discriminated union 新字段
    shadowMessages: payload.messages,          // shadow path 真信息源
    intent: opts.task ?? '',                                                    // δ phase 218: 字段重命名 intentPreview → intent (union 合并)、消费时由 audit class 截
    timeoutMs: payload.budget.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS,
    maxSteps: payload.budget.maxSteps ?? SHADOW_MAX_STEPS_DEFAULT,
    parentClawId: opts.ctx.clawId ?? '',
    originClawId: payload.identity.originClawId ?? '',
    callerType: 'shadow_subagent',
    toolProfile: 'full',
    isShadow: payload.identity.isShadow,
    systemPrompt: payload.systemPrompt,
    shadowSystemPrompt: payload.systemPrompt,
    shadowToolsForLLM: payload.toolsForLLM,
    postProcessor: payload.postProcessor,
  });

  return { taskId: makeShortTaskId(taskId), shadowId: payload.identity.shadowId };
}
