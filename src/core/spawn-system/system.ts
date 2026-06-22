/**
 * spawn-system runtime helpers
 *
 * phase 766 sync 路径 wire (Phase YYY ratified)，封装 spawn 工具 sync 路径调用。
 * async 路径走 AsyncTaskSystem.schedule（phase 1332 inlined）。
 */

import * as path from 'path';
import { newShortUuid } from '../../foundation/uuid.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';

import { TASKS_SYNC_SPAWN_DIR } from './constants.js';
// phase 691 Step C: deep import dirs.ts leaf (避 barrel 触发已有 cycle / 同 verifier-job)
import { TASKS_SYNC_DIR } from '../async-task-system/dirs.js';
import { runSubagent as defaultRunSubagent, createPerTaskRegistry, getDisplayResult } from '../subagent/index.js';

import { SPAWN_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from './_helpers.js';
import { SHADOW_CALLER_LABEL } from '../shadow-system/index.js';


export interface RunSpawnSyncOptions {
  intent: string;
  timeoutMs: number;
  maxSteps?: number;
  systemPrompt: string;
  ctx: ExecContext;
  runSubagent?: typeof defaultRunSubagent;
}

/**
 * spawn 工具 sync 路径调用 helper
 * mirror verifier-job sync subagent lifecycle 调用模板（phase 750 立）
 */
export async function runSpawnSync(opts: RunSpawnSyncOptions): Promise<ToolResult> {
  const id = `spawn-${newShortUuid()}`;
  const resultDir = path.join(opts.ctx.clawDir, TASKS_SYNC_SPAWN_DIR, id);

  const aw = opts.ctx.auditWriter;
  if (aw) {
    // phase 708: raw id/intent 加 key= prefix、forensic 可 join spawnId/intent 维度
    aw.write(SPAWN_AUDIT_EVENTS.SYNC_STARTED, `spawnId=${id}`, `intent=${aw.preview(opts.intent)}`);
  }

  try {
    if (!opts.ctx.registry) {
      throw new Error('Tool registry not available in execution context');
    }
    if (!opts.ctx.llm) {
      throw new Error('LLM not available in execution context');
    }

    // mirror verifier-job 既有调用模板：从 caller registry 取 subagent profile 工具
    const subagentRegistry = createPerTaskRegistry(opts.ctx.registry, 'subagent');

    const subagentImpl = opts.runSubagent ?? defaultRunSubagent;
    const { text, capturedResult } = await subagentImpl({
      agentId: id,
      callerType: 'subagent',
      clawDir: opts.ctx.clawDir,
      fs: opts.ctx.fs,
      fsFactory: opts.ctx.fsFactory,
      llm: opts.ctx.llm,
      registry: subagentRegistry,
      prompt: opts.intent,
      systemPrompt: opts.systemPrompt,
      resultDir,
      syncDir: path.join(opts.ctx.clawDir, TASKS_SYNC_DIR),
      maxSteps: opts.maxSteps ?? opts.ctx.subagentMaxSteps ?? opts.ctx.maxSteps,
      timeoutMs: opts.timeoutMs,
      isShadow: opts.ctx.callerLabel === SHADOW_CALLER_LABEL,
      signal: opts.ctx.signal,
      toolTimeoutMs: opts.ctx.toolTimeoutMs,
      permissionChecker: opts.ctx.permissionChecker,
    });

    const content = getDisplayResult(text, capturedResult);
    // phase 708: raw id 加 key= prefix
    opts.ctx.auditWriter?.write(SPAWN_AUDIT_EVENTS.SYNC_FINISHED, `spawnId=${id}`);
    return {
      success: true,
      content,
      metadata: { spawnId: id, sync: true },
    };
  } catch (err) {
    const errMsg = formatErr(err);
    // phase 708: raw id/errMsg 加 key= prefix
    opts.ctx.auditWriter?.write(SPAWN_AUDIT_EVENTS.SYNC_FAILED, `spawnId=${id}`, `error=${errMsg}`);
    return {
      success: false,
      content: `[chestnut spawn] sync execution failed: ${errMsg}`,
      error: 'spawn_sync_failed',
    };
  }
}
