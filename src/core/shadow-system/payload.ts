/**
 * @module L4.ShadowSystem.Payload
 * @layer L4
 *
 * phase 1865 (SH-D1)：`ShadowExecutorPayload` 契约的 owner 构造器——
 * shadow 执行语义集合（prompt/messages/tools/identity/budget）在此单点构造。
 * 消费侧（ATS 侧 opaque executorPayload 形态迁移）归 phase 1863 E。
 */

import { newShortUuid, sha256Hex } from '../../foundation/node-utils/index.js';
import { createCanonicalToolManifestFromDefinitions } from '../../foundation/tools/index.js';
import { llmProviderProtocol } from '../../foundation/llm-provider/index.js';
const { makeToolUseId } = llmProviderProtocol;
import type { BuildShadowInstructionArgs } from '../../templates/prompts/index.js';

import { synthesizeFormB } from './_helpers.js';
import { SHADOW_DEFAULT_TIMEOUT_MS, SHADOW_DETACHED } from './constants.js';
import {
  DONE_TOOL_NAME,
  prepareSubagentInput,
  type PreparedSubagentInput,
} from '../subagent/index.js';
import type {
  LegacyShadowPayloadDecodeResult,
  ShadowExecutorPayload,
  ShadowIdentity,
  SpawnShadowSubagentOptions,
} from './types.js';

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
    toolsForLLM: structuredClone(opts.toolsForLLM),
    manifestRevision: opts.manifestRevision
      ?? createCanonicalToolManifestFromDefinitions(opts.toolsForLLM).revision,
    promptRevision: opts.promptRevision ?? sha256Hex(opts.systemPrompt),
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

/** Shadow's established agent-loop cap; ordinary SubAgent defaults do not replace it. */
const SHADOW_MAX_STEPS_DEFAULT = 100;

/** Freeze Shadow's parent snapshot and execution restrictions before submission. */
export function prepareShadowInput(payload: ShadowExecutorPayload): PreparedSubagentInput {
  const manifest = createCanonicalToolManifestFromDefinitions(payload.toolsForLLM);
  if (manifest.revision !== payload.manifestRevision) {
    throw new TypeError(
      `shadow manifest revision mismatch: parent=${payload.manifestRevision} canonical=${manifest.revision}`,
    );
  }
  return prepareSubagentInput({
    prompt: '',
    systemPrompt: payload.systemPrompt,
    messages: payload.messages,
    tools: { manifest },
    execution: {
      callerKind: 'shadow',
      allowDone: true,
      allowShadow: false,
      allowSummon: false,
      allowNotifyClaw: false,
      manifestRevision: manifest.revision,
    },
    toolProfile: 'full',
    budget: {
      timeoutMs: payload.budget.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS,
      maxSteps: payload.budget.maxSteps ?? SHADOW_MAX_STEPS_DEFAULT,
      ...(payload.budget.idleTimeoutMs !== undefined
        ? { idleTimeoutMs: payload.budget.idleTimeoutMs }
        : {}),
    },
    resultCapture: { toolName: DONE_TOOL_NAME },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

/** Exhaustive legacy owner-shape validation; no field is stripped or defaulted. */
function isShadowExecutorPayload(value: unknown): value is ShadowExecutorPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'systemPrompt', 'messages', 'toolsForLLM', 'manifestRevision', 'promptRevision',
    'identity', 'detached', 'budget', 'postProcessor',
  ])) return false;
  if (value.detached !== SHADOW_DETACHED || typeof value.systemPrompt !== 'string') return false;
  if (!Array.isArray(value.messages) || !Array.isArray(value.toolsForLLM)) return false;
  if (typeof value.manifestRevision !== 'string' || value.manifestRevision.length === 0) return false;
  if (typeof value.promptRevision !== 'string' || value.promptRevision.length === 0) return false;
  if (value.postProcessor !== undefined && typeof value.postProcessor !== 'string') return false;
  if (!isRecord(value.identity) || !hasOnlyKeys(value.identity, ['shadowId', 'originClawId', 'isShadow'])) return false;
  if (typeof value.identity.shadowId !== 'string' || value.identity.shadowId.length === 0
    || value.identity.isShadow !== true
    || (value.identity.originClawId !== undefined && typeof value.identity.originClawId !== 'string')) return false;
  if (!isRecord(value.budget) || !hasOnlyKeys(value.budget, ['timeoutMs', 'maxSteps', 'idleTimeoutMs'])) return false;
  if (!isOptionalNonNegativeNumber(value.budget.timeoutMs)
    || !isOptionalNonNegativeNumber(value.budget.idleTimeoutMs)) return false;
  return isOptionalNonNegativeNumber(value.budget.maxSteps)
    && (value.budget.maxSteps === undefined || (typeof value.budget.maxSteps === 'number'
      && Number.isInteger(value.budget.maxSteps)));
}

function hasShadowPayloadMarker(value: Record<string, unknown>): boolean {
  if (Object.hasOwn(value, 'detached')) return true;
  if (isRecord(value.identity)
    && (value.identity.isShadow === true || typeof value.identity.shadowId === 'string')) return true;
  return ['systemPrompt', 'toolsForLLM', 'manifestRevision', 'promptRevision', 'budget']
    .every(key => Object.hasOwn(value, key));
}

/**
 * Migration-only legacy reader. Unknown owners remain not_applicable; a recognized
 * Shadow payload with damaged or inconsistent fields is explicitly invalid.
 */
export function decodeLegacyShadowPayload(payload: unknown): LegacyShadowPayloadDecodeResult {
  if (!isRecord(payload) || !hasShadowPayloadMarker(payload)) return { kind: 'not_applicable' };
  if (!isShadowExecutorPayload(payload)) {
    return { kind: 'invalid', reason: 'legacy Shadow executor payload failed owner-shape validation' };
  }
  try {
    prepareShadowInput(payload);
    return { kind: 'decoded', value: structuredClone(payload) };
  } catch (error) {
    return {
      kind: 'invalid',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
