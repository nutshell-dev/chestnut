/**
 * @module L4.ShadowSystem.SpawnShadowSubagent
 * @layer L4
 * @depends L4.AsyncTaskSystem.schedule, L4.ShadowSystem._helpers (synthesizeFormB), L2.Prompts (buildShadowInstruction)
 *
 * 装配 shadow subagent task 唯一入口 (ML#1 + ML#2 + ML#3 align)。
 *
 * phase 1185 derive：phase 1142 升 SHADOW INSTRUCTION primitives 为 public 但「装配组合」散落 shadow.ts + summon.ts、
 * 真 production 双 push bug 实证、ML#11「停下来重构」兑现。
 */

import { randomUUID } from 'crypto';
import { UUID_SHORT_LEN } from '../../../../constants.js';
import type { Message } from '../../../../foundation/llm-provider/types.js';

import { synthesizeFormB } from './_helpers.js';
import { type BuildShadowInstructionArgs } from '../../../../prompts/index.js';
import type { SpawnShadowSubagentOptions, SpawnShadowSubagentResult } from './types.js';
import { makeTaskId } from '../../../async-task-system/types.js';
import { makeToolUseId } from '../../../../foundation/tool-protocol/index.js';

/** Default max steps for shadow subagent execution */
const SHADOW_MAX_STEPS_DEFAULT = 100;
import { SHADOW_DEFAULT_TIMEOUT_MS, SHADOW_INTENT_PREVIEW_CHARS } from './constants.js';



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
    intentPreview: opts.task.slice(0, SHADOW_INTENT_PREVIEW_CHARS),     // δ shadow variant audit 用、不进 LLM
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
  });

  return { taskId: makeTaskId(taskId), shadowId };
}
