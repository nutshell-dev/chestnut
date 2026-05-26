/**
 * @module L4.ShadowSystem.SpawnShadowSubagent
 * @layer L4
 * @depends L4.AsyncTaskSystem.writePendingSubagentTaskFile, L4.ShadowSystem._helpers (synthesizeFormB), L2.Prompts (buildShadowInstruction)
 *
 * 装配 shadow subagent task 唯一入口 (ML#1 + ML#2 + ML#3 align)。
 *
 * phase 1185 derive：phase 1142 升 SHADOW INSTRUCTION primitives 为 public 但「装配组合」散落 shadow.ts + summon.ts、
 * 真 production 双 push bug 实证、ML#11「停下来重构」兑现。
 */

import { randomUUID } from 'crypto';
import type { Message } from '../../foundation/llm-provider/types.js';
import { writePendingSubagentTaskFile } from '../async-task-system/tools/_pending-task-writer.js';
import { synthesizeFormB } from './_helpers.js';
import { type BuildShadowInstructionArgs } from '../../prompts/index.js';
import type { SpawnShadowSubagentOptions, SpawnShadowSubagentResult } from './types.js';

export async function spawnShadowSubagent(
  opts: SpawnShadowSubagentOptions,
): Promise<SpawnShadowSubagentResult> {
  const prefix = opts.shadowIdPrefix ?? 'shadow';
  const shadowId = `${prefix}-${randomUUID().slice(0, 8)}`;

  const instructionArgs: Omit<BuildShadowInstructionArgs, 'shadowToolName'> = {
    shadowId,
    spawnedAt: new Date().toISOString(),
    spawnedByClawId: opts.ctx.clawId ?? '',
    toolUseId: opts.ctx.currentToolUseId ?? '',
    task: opts.task,
  };
  // synthesizeFormB 内部调 buildShadowInstruction(instructionArgs) 嵌 task 到 SHADOW INSTRUCTION
  const shadowMessages: Message[] = synthesizeFormB({
    mainMessagesBeforeMarker: opts.mainMessages,
    instructionArgs,
  });

  const taskId = await writePendingSubagentTaskFile(opts.ctx.fs, opts.ctx.auditWriter, {
    kind: 'subagent',
    mode: 'shadow',                            // δ discriminated union 新字段
    shadowMessages,                            // shadow path 真信息源
    intentPreview: opts.task.slice(0, 60),     // δ shadow variant audit 用、不进 LLM
    timeoutMs: opts.timeoutMs ?? 300_000,
    maxSteps: opts.maxSteps ?? 100,
    parentClawId: opts.ctx.clawId ?? '',
    originClawId: opts.ctx.originClawId ?? opts.ctx.clawId ?? '',
    callerType: 'shadow',
    isShadow: true,
    systemPrompt: opts.systemPrompt,
    shadowSystemPrompt: opts.systemPrompt,
    shadowToolsForLLM: opts.toolsForLLM,
    postProcessor: opts.postProcessor,
  });

  return { taskId, shadowId };
}
