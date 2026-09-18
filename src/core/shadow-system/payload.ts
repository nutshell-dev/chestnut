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
import { SHADOW_DETACHED } from './constants.js';
import { DONE_TOOL_NAME } from '../subagent/index.js';
import type { ShadowExecutorPayload, ShadowIdentity, SpawnShadowSubagentOptions } from './types.js';
import type { ExecutorPayloadInterpretation } from '../async-task-system/index.js';

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
    detached: SHADOW_DETACHED,
    budget: {
      timeoutMs: opts.timeoutMs,
      maxSteps: opts.maxSteps,
      idleTimeoutMs: opts.idleTimeoutMs,
    },
    postProcessor: opts.postProcessor,
  };
}

/** phase 1863 (AT-D7)：识别 ShadowExecutorPayload（契约字段判别，不猜形状）。 */
function isShadowExecutorPayload(v: unknown): v is ShadowExecutorPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (p.detached !== SHADOW_DETACHED) return false;
  if (typeof p.systemPrompt !== 'string') return false;
  if (!Array.isArray(p.messages) || !Array.isArray(p.toolsForLLM)) return false;
  const identity = p.identity as Record<string, unknown> | null | undefined;
  return !!identity && typeof identity.shadowId === 'string' && identity.isShadow === true;
}

/**
 * phase 1863 (AT-D7)：executor payload 解释面（shadow owner 提供、装配注入 AsyncTaskSystem）——
 * ATS 只透传 opaque payload，shadow 语义（空 prompt / shadow systemPrompt / 合成 messages /
 * 受限工具 / done 捕获）在此收口。
 */
export function interpretShadowExecutorPayload(payload: unknown): ExecutorPayloadInterpretation | undefined {
  if (!isShadowExecutorPayload(payload)) return undefined;
  return {
    prompt: '',
    systemPrompt: payload.systemPrompt,
    messages: payload.messages,
    applyRestrictedOverrides: true,
    resultTool: DONE_TOOL_NAME,
  };
}
