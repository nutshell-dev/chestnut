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

import { randomUUID } from 'crypto';
import { UUID_SHORT_LEN } from '../../constants.js';
import type { Message } from '../../foundation/llm-provider/types.js';

import { synthesizeFormB } from './_helpers.js';
import { type BuildShadowInstructionArgs } from '../../templates/prompts/index.js';
import type { SpawnShadowSubagentOptions, SpawnShadowSubagentResult } from './types.js';
import { makeTaskId } from '../async-task-system/types.js';
import { makeToolUseId } from '../../foundation/tool-protocol/index.js';

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
  if (!opts.ctx.taskSystem) {
    return {
      success: false,
      content: '[shadow spawn] task_system not available in execution context — shadow path requires AsyncTaskSystem injection',
      error: 'task_system_unavailable',
    };
  }

  const prefix = opts.shadowIdPrefix ?? 'shadow';
  const shadowId = `${prefix}-${randomUUID().slice(0, UUID_SHORT_LEN)}`;

  const instructionArgs: Omit<BuildShadowInstructionArgs, 'shadowToolName'> = {
    shadowId,
    spawnedAt: new Date().toISOString(),
    spawnedByClawId: opts.ctx.clawId ?? '',
    toolUseId: opts.ctx.currentToolUseId
      ? makeToolUseId(opts.ctx.currentToolUseId)
      : makeToolUseId(`shadow_${randomUUID().slice(0, UUID_SHORT_LEN)}`),
    task: opts.task,
  };
  // synthesizeFormB 内部调 buildShadowInstruction(instructionArgs) 嵌 task 到 SHADOW INSTRUCTION
  const shadowMessages: Message[] = synthesizeFormB({
    mainMessagesBeforeMarker: opts.mainMessages,
    instructionArgs,
  });

  // phase 1373 anchor: shadow-mode subagent 不继承 caller signal by-design
  // (shadow 是异步 detach / caller abort 不应级联 abort shadow / 业务语义 mutually exclusive lifecycle)
  // 若 future shadow abort 需求 N≥1 → 加 NEW shadowSignal parameter + propagate
  const taskId = await opts.ctx.taskSystem.schedule('subagent', {
    kind: 'subagent',
    mode: 'shadow',                            // δ discriminated union 新字段
    shadowMessages,                            // shadow path 真信息源
    intent: opts.task,                                                    // δ phase 218: 字段重命名 intentPreview → intent (union 合并)、消费时由 audit class 截
    timeoutMs: opts.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS,
    maxSteps: opts.maxSteps ?? SHADOW_MAX_STEPS_DEFAULT,
    parentClawId: opts.ctx.clawId ?? '',
    originClawId: opts.ctx.originClawId ?? opts.ctx.clawId ?? '',
    callerType: 'shadow',
    isShadow: true,
    systemPrompt: opts.systemPrompt,
    shadowSystemPrompt: opts.systemPrompt,
    shadowToolsForLLM: opts.toolsForLLM,
    postProcessor: opts.postProcessor,
    summonDecision: opts.summonDecision,
  });

  return { taskId: makeTaskId(taskId), shadowId };
}
