/**
 * phase 767 NEW
 * shadow-system runtime helper，同步路径持有 SubAgent 执行引用并等待真实完成
 * mirror verifier-job phase 750 加 spawn-system runSpawnSync phase 766 模板
 */

import * as path from 'path';
import { formatErr } from '../../foundation/node-utils/index.js';
import {
  createCanonicalToolManifestFromDefinitions,
  type ExecContext,
} from '../../foundation/tools/index.js';
import { sha256Hex } from '../../foundation/node-utils/index.js';
import { applyRestrictedOverrides } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import { llmProviderProtocol } from '../../foundation/llm-provider/index.js';
const { makeToolUseId } = llmProviderProtocol;
type ToolUseId = llmProviderProtocol.ToolUseId;
import type { Message } from '../../foundation/dialog-store/index.js';

import { TASKS_SYNC_SHADOW_DIR, SHADOW_DEFAULT_TIMEOUT_MS } from './constants.js';
import {
  runSubagent as defaultRunSubagent,
  createPerTaskRegistry,
  getDisplayResult,
  DONE_TOOL_NAME,
  prepareSubagentInput,
  projectSubagentResult,
  type RunSubagentOptions,
  type RunSubagentResult,
  type SubagentExecutionIdentity,
  type SubagentExecutionRef,
  type SubagentFinalOutcome,
  type SubagentRunner,
  type SubagentStartRequest,
} from '../subagent/index.js';

import { synthesizeFormB } from './_helpers.js';
import { createShadowIdentity } from './payload.js';
import {
  emitShadowStarted,
  emitShadowPrefixRestored,
  emitShadowFinished,
  emitShadowFailed,
} from './lifecycle-audit.js';
import { classifyTaskError } from '../async-task-system/index.js';
import type { BuildShadowInstructionArgs } from '../../templates/prompts/index.js';
import type { ShadowRunFailure } from './types.js';

/** phase 1865 (SH-D5)：kind → 工具层 error 字段（由 kind 派生；既有字符串值保持）。 */
const FAILURE_ERROR_CODE: Record<ShadowRunFailure['kind'], string> = {
  no_main_context: 'no_main_context',
  prefix_synthesis: 'prefix_synthesis_failed',
  registry_unavailable: 'registry_unavailable',
  manifest_mismatch: 'shadow_manifest_revision_mismatch',
  llm_unavailable: 'llm_unavailable',
};

/** phase 1865 (SH-D5)：kind → FAILED 事件的 phase col（留痕阶段标识）。 */
const FAILURE_AUDIT_PHASE: Record<ShadowRunFailure['kind'], string> = {
  no_main_context: 'main_context',
  prefix_synthesis: 'prefix_restore',
  registry_unavailable: 'registry',
  manifest_mismatch: 'manifest',
  llm_unavailable: 'llm',
};

/** phase 1865 (SH-D5)：失败统一产出——一条 FAILED 留痕 + typed outcome 派生的工具层返回。 */
function failShadow(
  ctx: ExecContext,
  shadowId: string,
  failure: ShadowRunFailure,
  message: string,
  auditError: string,
): ToolResult {
  emitShadowFailed(ctx.auditWriter, shadowId, auditError, FAILURE_AUDIT_PHASE[failure.kind]);
  return { success: false, content: message, error: FAILURE_ERROR_CODE[failure.kind] };
}





/** Minimal structural port; SubAgent retains execution and persistence ownership. */
export type ShadowSubagentRunner = Pick<SubagentRunner, 'start'>;

interface RunShadowOptions {
  task: string;
  timeoutMs?: number;
  maxSteps?: number;
  ctx: ExecContext;
  /** Pre-stripped main agent messages (shadow.ts already removed incomplete tool_use) */
  mainMessages?: Message[];
  /** L4 turn state snapshot — injected by shadow tool factory (not from ctx) */
  turnSnapshot?: {
    systemPrompt?: string;
    tools?: llmProviderProtocol.ToolDefinition[];
    messages?: Message[];
    manifestRevision?: string;
    promptRevision?: string;
  };
  /** Execution-reference consumer port; Assembly binds the fixed SubAgent capability. */
  subagentRunner?: ShadowSubagentRunner;
  /** Transitional compatibility projection until Assembly completes the runner binding. */
  runSubagent?: typeof defaultRunSubagent;
}

function findLastAssistantWithToolUse(messages: Message[], toolUseId: ToolUseId): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const hasMarker = msg.content.some(
      b => (b as { type?: string; id?: string }).type === 'tool_use' && (b as { id?: string }).id === toolUseId,
    );
    if (hasMarker) return i;
  }
  return -1;
}

function executionMetadata(final: SubagentFinalOutcome): Record<string, unknown> {
  return {
    execution: final.identity,
    outcomeKind: final.kind,
    ...(final.evidenceRef !== undefined ? { executionEvidenceRef: final.evidenceRef } : {}),
    executionRecovery: final.recovery,
    degraded: final.degraded,
    ...(final.cause !== undefined ? { cause: final.cause } : {}),
  };
}

function projectCompletedResult(final: SubagentFinalOutcome): RunSubagentResult {
  return projectSubagentResult(final);
}

function failShadowOutcome(
  ctx: ExecContext,
  shadowId: string,
  resultDir: string,
  final: SubagentFinalOutcome,
): ToolResult {
  const cause = final.cause !== undefined ? final.cause : new Error(final.content);
  const errMsg = formatErr(cause);
  const classified = classifyTaskError(cause);
  emitShadowFailed(ctx.auditWriter, shadowId, errMsg);
  return {
    success: false,
    content: `[chestnut shadow] execution ${final.kind === 'interrupted' ? 'interrupted' : 'failed'}: ${errMsg}`,
    error: final.kind === 'interrupted' && classified === 'unknown' ? 'abort' : classified,
    metadata: {
      shadowId,
      shadowAuditPath: `${resultDir}/audit.tsv`,
      ...executionMetadata(final),
    },
  };
}

export async function runShadow(opts: RunShadowOptions): Promise<ToolResult> {
  // phase 1865 (SH-D3)：单一身份上下文（isShadow 事实派生自此，不再硬编码）。
  const identity = createShadowIdentity({ originClawId: opts.ctx.clawId });
  const shadowId = identity.shadowId;
  const resultDir = path.join(opts.ctx.clawDir, TASKS_SYNC_SHADOW_DIR, shadowId);
  const spawnedAt = new Date().toISOString();

  emitShadowStarted(opts.ctx.auditWriter, shadowId, opts.task);

  const ts = opts.turnSnapshot;
  // V1 validation: needs turnSnapshot
  if (
    !opts.ctx.clawId ||
    !opts.ctx.currentToolUseId ||
    ts?.systemPrompt === undefined ||
    ts?.tools === undefined
  ) {
    const missing = [
      ...(!opts.ctx.clawId ? ['clawId'] : []),
      ...(!opts.ctx.currentToolUseId ? ['currentToolUseId'] : []),
      ...(ts?.systemPrompt === undefined ? ['systemPrompt'] : []),
      ...(ts?.tools === undefined ? ['tools'] : []),
    ];
    return failShadow(
      opts.ctx,
      shadowId,
      { kind: 'no_main_context', missing },
      '[chestnut shadow] missing main agent in-memory state (clawId, currentToolUseId, systemPrompt, or tools)',
      `missing=${missing.join(',')}`,
    );
  }
  if (!opts.mainMessages && !ts?.messages) {
    return failShadow(
      opts.ctx,
      shadowId,
      { kind: 'no_main_context', missing: ['dialogMessages'] },
      '[chestnut shadow] missing main agent in-memory state (dialogMessages)',
      'missing=dialogMessages',
    );
  }

  const restoredSystemPrompt: string = ts!.systemPrompt!;
  const restoredTools = structuredClone(ts!.tools!);
  const manifestRevision = ts!.manifestRevision
    ?? createCanonicalToolManifestFromDefinitions(restoredTools).revision;
  const promptRevision = ts!.promptRevision ?? sha256Hex(restoredSystemPrompt);

  let synthesizedMessages: Message[];

  try {
    // V1: find marker, strip, synthesizeFormB
    const baseMessages = opts.mainMessages ?? ts!.messages!;
    const instructionArgs: Omit<BuildShadowInstructionArgs, 'shadowToolName'> = {
      shadowId,
      spawnedAt,
      spawnedByClawId: opts.ctx.clawId,
      toolUseId: makeToolUseId(opts.ctx.currentToolUseId),
      task: opts.task,
    };
    const mainMessagesBeforeMarker = opts.mainMessages
      ?? (() => {
        const idx = findLastAssistantWithToolUse(baseMessages, makeToolUseId(opts.ctx.currentToolUseId));
        if (idx < 0) throw new Error(`marker not found: ${opts.ctx.currentToolUseId}`);
        return baseMessages.slice(0, idx);
      })();
    synthesizedMessages = synthesizeFormB({
      mainMessagesBeforeMarker,
      instructionArgs,
    });
    emitShadowPrefixRestored(opts.ctx.auditWriter, shadowId);
  } catch (err) {
    const errMsg = formatErr(err);
    return failShadow(
      opts.ctx,
      shadowId,
      { kind: 'prefix_synthesis', error: errMsg },
      `[chestnut shadow] prefix synthesis failed: ${errMsg}`,
      errMsg,
    );
  }

  // shadow 用 full profile（C2 cache prefix 保护，mirror main agent 字节相同）；
  // phase 1858 Step J (SA-D9): 删 SubAgentOptions.isShadow 传参（该字段无消费、亦非 ctx 注入）。
  // shadow 隔离由 applyRestrictedOverrides 覆盖受限工具表达。
  const baseRegistry = opts.ctx.baseRegistry ?? opts.ctx.registry;
  if (!baseRegistry) {
    const detail = 'Tool registry not available in execution context';
    return failShadow(opts.ctx, shadowId, { kind: 'registry_unavailable', detail }, `[chestnut shadow] registry unavailable: ${detail}`, detail);
  }
  if (!opts.ctx.registry) {
    const detail = 'Main tool registry not available in execution context';
    return failShadow(opts.ctx, shadowId, { kind: 'registry_unavailable', detail }, `[chestnut shadow] registry unavailable: ${detail}`, detail);
  }
  if (!opts.ctx.llm) {
    const detail = 'LLM not available in execution context';
    return failShadow(opts.ctx, shadowId, { kind: 'llm_unavailable', detail }, `[chestnut shadow] llm unavailable: ${detail}`, detail);
  }

  let liveManifestRevision: string | undefined;
  if (typeof baseRegistry.getManifest === 'function') {
    try {
      liveManifestRevision = baseRegistry.getManifest()?.revision;
    } catch {
      // silent: a direct legacy test registry may be unfrozen; production Assembly is frozen.
    }
  }
  if (liveManifestRevision && liveManifestRevision !== manifestRevision) {
    const detail = `parent=${manifestRevision} live=${liveManifestRevision}`;
    return failShadow(
      opts.ctx,
      shadowId,
      { kind: 'manifest_mismatch', detail },
      `[chestnut shadow] manifest revision mismatch: ${detail}`,
      detail,
    );
  }

  let execution: SubagentExecutionRef | undefined;
  let finalOutcome: SubagentFinalOutcome | undefined;
  let executionIdentity: SubagentExecutionIdentity | undefined;
  try {

    const shadowRegistry = createPerTaskRegistry(baseRegistry, 'full');

    // Phase 807: 覆盖 shadow registry 中的限制版工具，ToolDefinition 不变、KV cache 命中。
    // 通过 clone + 改 DI 属性实现；execute 内读取 this.DI_FIELD。
    // Phase 811: 从 mainRegistry 取受限工具（baseRegistry 只含基础工具）
    // Phase 814/816: 各工具自声明 restrictedOverrides，foundation 通用 apply，不再硬编码具体工具名。
    applyRestrictedOverrides(shadowRegistry, opts.ctx.registry);

    const request: RunSubagentOptions = {
      agentId: shadowId,
      toolProfile: 'full',
      clawDir: opts.ctx.clawDir,
      fs: opts.ctx.fs,
      fsFactory: opts.ctx.fsFactory,
      llm: opts.ctx.llm,
      registry: shadowRegistry,
      prompt: '',   // shadow 不用 prompt 字段（指令在 synthesized messages 末）
      systemPrompt: restoredSystemPrompt,
      toolsForLLM: restoredTools,
      messages: synthesizedMessages,
      execution: {
        callerKind: 'shadow',
        allowDone: true,
        allowShadow: false,
        allowSummon: false,
        allowNotifyClaw: false,
        manifestRevision,
      },
      resultDir,
      syncDir: opts.ctx.syncDir,
      maxSteps: opts.maxSteps,
      timeoutMs: opts.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS,
      // phase 369 §4 (review-2026-06-13): 用 const、tool 重命名时 shadow-system 跟住
      resultTool: DONE_TOOL_NAME,
      // Phase 2248 H2: only synchronous Shadow inherits the parent signal. The
      // SubAgent runner keeps it attached until actual convergence; G4 async stays detached.
      signal: opts.ctx.signal,
      permissionChecker: opts.ctx.permissionChecker,
    };

    let result: RunSubagentResult;
    if (opts.subagentRunner) {
      const timeoutMs = opts.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS;
      const input = prepareSubagentInput({
        prompt: '',
        systemPrompt: restoredSystemPrompt,
        messages: synthesizedMessages,
        tools: { manifest: createCanonicalToolManifestFromDefinitions(restoredTools) },
        execution: request.execution,
        toolProfile: 'full',
        budget: {
          timeoutMs,
          ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        },
        resultCapture: { toolName: DONE_TOOL_NAME },
      });
      const startRequest: SubagentStartRequest = {
        runId: shadowId,
        resultDir: `${TASKS_SYNC_SHADOW_DIR}/${shadowId}`,
        input,
        signal: opts.ctx.signal,
        deadlineAtMs: Date.now() + timeoutMs,
      };
      execution = await opts.subagentRunner.start(startRequest);
      executionIdentity = execution.identity;
      finalOutcome = await execution.completion;
      executionIdentity = finalOutcome.identity;
      if (finalOutcome.kind !== 'completed') {
        return failShadowOutcome(opts.ctx, shadowId, resultDir, finalOutcome);
      }
      result = projectCompletedResult(finalOutcome);
    } else {
      result = await (opts.runSubagent ?? defaultRunSubagent)(request);
    }
    const { text, capturedResult } = result;
    const finalResult = getDisplayResult(text, capturedResult);
    emitShadowFinished(opts.ctx.auditWriter, shadowId);
    return {
      success: true,
      content: finalResult,
      metadata: {
        shadowId,
        source: capturedResult ? 'done' : 'text',
        manifestRevision,
        promptRevision,
        ...(finalOutcome ? executionMetadata(finalOutcome) : {}),
      },
    };
  } catch (err) {
    const errMsg = formatErr(err);
    emitShadowFailed(opts.ctx.auditWriter, shadowId, errMsg);
    return {
      success: false,
      content: `[chestnut shadow] execution failed: ${errMsg}`,
      error: classifyTaskError(err),
      metadata: {
        shadowId,
        shadowAuditPath: `${resultDir}/audit.tsv`,
        ...(finalOutcome
          ? executionMetadata(finalOutcome)
          : executionIdentity !== undefined ? { execution: executionIdentity } : {}),
        cause: err,
      },
    };
  }
}

