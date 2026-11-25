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

import { buildShadowPayload, prepareShadowInput } from './payload.js';
import type { SpawnShadowSubagentOptions, SpawnShadowSubagentResult } from './types.js';

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

  // Phase 2248 G4: Shadow owns the complete declaration; ATS persists only its
  // versioned envelope and SubAgent validates the nested input before execution.
  const payload = buildShadowPayload(opts);
  const preparedInput = prepareShadowInput(payload);

  // phase 1373 anchor: shadow-mode subagent 不继承 caller signal by-design
  // (shadow 是异步 detach / caller abort 不应级联 abort shadow / 业务语义 mutually exclusive lifecycle)
  // 若 future shadow abort 需求 N≥1 → 加 NEW shadowSignal parameter + propagate
  // phase 1865 (SH-D4)：语义已进契约面（payload.detached，ratify 链见 SpawnShadowSubagentOptions JSDoc）；本处行为不变。
  const taskId = await opts.taskSystem.schedule('subagent', {
    kind: 'subagent',
    executionInput: { schema_version: 1, input: preparedInput },
    intent: opts.task ?? '',                                                    // δ phase 218: 字段重命名 intentPreview → intent (union 合并)、消费时由 audit class 截
    timeoutMs: preparedInput.budget.timeoutMs,
    maxSteps: preparedInput.budget.maxSteps,
    parentClawId: opts.ctx.clawId ?? '',
    originClawId: payload.identity.originClawId ?? '',
    correlation: { source: 'shadow_subagent' },   // phase 1863 (AT-D8)：opaque correlation
    toolProfile: 'full',
    postProcessor: payload.postProcessor,
  });

  // phase 1863 (AT-D11)：scheduler 契约返回 ShortTaskId（brand 经契约传播）
  return { taskId, shadowId: payload.identity.shadowId };
}
