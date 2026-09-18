/**
 * @module L4.ShadowSystem.Payload
 * @layer L4
 *
 * phase 1865 (SH-D1)：`ShadowExecutorPayload` 契约的 owner 构造器——
 * shadow 执行语义集合（prompt/messages/tools/identity/budget）在此单点构造。
 * 消费侧（ATS 侧 opaque executorPayload 形态迁移）归 phase 1863 E。
 */

import { newShortUuid } from '../../foundation/node-utils/index.js';
import { makeToolUseId } from '../../foundation/llm-provider/index.js';
import type { BuildShadowInstructionArgs } from '../../templates/prompts/index.js';

import { synthesizeFormB } from './_helpers.js';
import type { ShadowExecutorPayload, ShadowIdentity, SpawnShadowSubagentOptions } from './types.js';

/** phase 1865 (SH-D3)：身份单一构造点——shadowId 生成 + isShadow 事实（消费面派生自此）。 */
export function createShadowIdentity(opts: { prefix?: string; originClawId?: string }): ShadowIdentity {
  return {
    shadowId: `${opts.prefix ?? 'shadow'}-${newShortUuid()}`,
    originClawId: opts.originClawId,
    isShadow: true,
  };
}

export function buildShadowPayload(opts: SpawnShadowSubagentOptions): ShadowExecutorPayload {
  const identity = createShadowIdentity({
    prefix: opts.shadowIdPrefix,
    originClawId: opts.originClawId ?? opts.ctx.clawId,
  });

  const instructionArgs: Omit<BuildShadowInstructionArgs, 'shadowToolName'> = {
    shadowId: identity.shadowId,
    spawnedAt: new Date().toISOString(),
    spawnedByClawId: opts.ctx.clawId ?? '',
    toolUseId: opts.ctx.currentToolUseId
      ? makeToolUseId(opts.ctx.currentToolUseId)
      : makeToolUseId(`shadow_${newShortUuid()}`),
    task: opts.task,
  };
  const messages = synthesizeFormB({
    mainMessagesBeforeMarker: opts.mainMessages,
    instructionArgs,
  });

  return {
    systemPrompt: opts.systemPrompt,
    messages,
    toolsForLLM: opts.toolsForLLM,
    identity,
    budget: {
      timeoutMs: opts.timeoutMs,
      maxSteps: opts.maxSteps,
      idleTimeoutMs: opts.idleTimeoutMs,
    },
    postProcessor: opts.postProcessor,
  };
}
