/**
 * spawn-system runtime helpers
 *
 * phase 766 sync 路径 wire (Phase YYY ratified)，封装 spawn 工具 sync 路径调用。
 * async 路径走 AsyncTaskSystem.schedule（phase 1332 inlined）。
 */

import * as path from 'path';
import { formatErr, newShortUuid } from '../../foundation/node-utils/index.js';
import { createCanonicalToolManifest, type ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';

import { TASKS_SYNC_SPAWN_DIR } from './constants.js';
import {
  createPerTaskRegistry,
  getDisplayResult,
  prepareSubagentInput,
  projectSubagentResult,
  runSubagent as defaultRunSubagent,
  type SubagentExecutionIdentity,
  type SubagentExecutionRef,
  type SubagentFinalOutcome,
  type SubagentRunner,
  type SubagentStartRequest,
} from '../subagent/index.js';

import { SPAWN_AUDIT_EVENTS } from './audit-events.js';

/** Minimal structural port; the production binding is supplied by Assembly. */
export type SpawnSubagentRunner = Pick<SubagentRunner, 'start'>;

export interface RunSpawnSyncOptions {
  intent: string;
  timeoutMs: number;
  maxSteps?: number;
  systemPrompt: string;
  ctx: ExecContext;
  subagentRunner?: SpawnSubagentRunner;
  /** Transitional compatibility projection until Assembly binds the runner. */
  runSubagent?: typeof defaultRunSubagent;
}

function outcomeEvidence(outcome: SubagentFinalOutcome): Record<string, unknown> {
  return {
    execution: outcome.identity,
    outcomeKind: outcome.kind,
    ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
    degraded: outcome.degraded,
  };
}

function displayCompletedResult(outcome: SubagentFinalOutcome): string {
  const result = projectSubagentResult(outcome);
  return getDisplayResult(result.text, result.capturedResult);
}

/**
 * spawn 工具 sync 路径调用 helper
 * mirror verifier-job sync subagent lifecycle 调用模板（phase 750 立）
 */
export async function runSpawnSync(opts: RunSpawnSyncOptions): Promise<ToolResult> {
  const id = `spawn-${newShortUuid()}`;
  const aw = opts.ctx.auditWriter;
  if (aw) {
    // phase 708: raw id/intent 加 key= prefix、forensic 可 join spawnId/intent 维度
    aw.write(SPAWN_AUDIT_EVENTS.SYNC_STARTED, `spawnId=${id}`, `intent=${aw.preview(opts.intent)}`);
  }

  let execution: SubagentExecutionRef | undefined;
  let final: SubagentFinalOutcome | undefined;
  let identity: SubagentExecutionIdentity | undefined;

  const fail = (cause: unknown): ToolResult => {
    const errMsg = formatErr(cause);
    // phase 708: raw id/errMsg 加 key= prefix
    opts.ctx.auditWriter?.write(SPAWN_AUDIT_EVENTS.SYNC_FAILED, `spawnId=${id}`, `error=${errMsg}`);
    return {
      success: false,
      content: `[chestnut spawn] sync execution failed: ${errMsg}`,
      error: 'spawn_sync_failed',
      metadata: {
        spawnId: id,
        sync: true,
        ...(identity !== undefined ? { execution: identity } : {}),
        cause,
        ...(final !== undefined ? { outcomeKind: final.kind, degraded: final.degraded } : {}),
      },
    };
  };

  try {
    const baseRegistry = opts.ctx.baseRegistry ?? opts.ctx.registry;
    if (!baseRegistry) {
      throw new Error('Tool registry not available in execution context');
    }
    if (!opts.ctx.llm) {
      throw new Error('LLM not available in execution context');
    }
    let content: string;
    if (opts.subagentRunner) {
      const input = prepareSubagentInput({
        prompt: opts.intent,
        systemPrompt: opts.systemPrompt,
        tools: { manifest: createCanonicalToolManifest(baseRegistry.getAll()) },
        toolProfile: 'subagent',
        budget: {
          timeoutMs: opts.timeoutMs,
          ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
          ...(opts.ctx.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.ctx.toolTimeoutMs } : {}),
        },
      });
      const request: SubagentStartRequest = {
        runId: id,
        resultDir: `${TASKS_SYNC_SPAWN_DIR}/${id}`,
        input,
        signal: opts.ctx.signal,
        deadlineAtMs: Date.now() + opts.timeoutMs,
      };
      execution = await opts.subagentRunner.start(request);
      identity = execution.identity;
      final = await execution.completion;
      identity = final.identity;

      if (final.kind !== 'completed') return fail(final.cause ?? new Error(final.content));
      content = displayCompletedResult(final);
    } else {
      const resultDir = path.join(opts.ctx.clawDir, TASKS_SYNC_SPAWN_DIR, id);
      const subagentRegistry = createPerTaskRegistry(baseRegistry, 'subagent');
      const { text, capturedResult } = await (opts.runSubagent ?? defaultRunSubagent)({
        agentId: id,
        toolProfile: 'subagent',
        clawDir: opts.ctx.clawDir,
        fs: opts.ctx.fs,
        fsFactory: opts.ctx.fsFactory,
        llm: opts.ctx.llm,
        registry: subagentRegistry,
        prompt: opts.intent,
        systemPrompt: opts.systemPrompt,
        resultDir,
        syncDir: opts.ctx.syncDir,
        maxSteps: opts.maxSteps,
        timeoutMs: opts.timeoutMs,
        signal: opts.ctx.signal,
        toolTimeoutMs: opts.ctx.toolTimeoutMs,
        permissionChecker: opts.ctx.permissionChecker,
      });
      content = getDisplayResult(text, capturedResult);
    }
    // phase 708: raw id 加 key= prefix
    opts.ctx.auditWriter?.write(SPAWN_AUDIT_EVENTS.SYNC_FINISHED, `spawnId=${id}`);
    return {
      success: true,
      content,
      metadata: { spawnId: id, sync: true, ...(final ? outcomeEvidence(final) : {}) },
    };
  } catch (err) {
    // silent: fail() emits the sync failure audit and returns the typed tool failure.
    return fail(err);
  }
}
