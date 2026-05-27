/**
 * spawn-system runtime helpers
 *
 * phase 766 sync 路径 wire (Phase YYY ratified)，封装 spawn 工具 sync 路径调用。
 * async 路径走 AsyncTaskSystem.schedule（phase 1332 inlined）。
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';

import { UUID_SHORT_LEN } from '../../constants.js';
import { TASKS_SYNC_SPAWN_DIR } from './constants.js';
import { runSubagent, createPerTaskRegistry, getDisplayResult } from '../subagent/index.js';
import { AUDIT_PREVIEW_LEN } from '../../foundation/constants.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../prompts/index.js';
import { SPAWN_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from './_helpers.js';


export interface RunSpawnSyncOptions {
  intent: string;
  timeoutMs: number;
  maxSteps?: number;
  ctx: ExecContext;
}

/**
 * spawn 工具 sync 路径调用 helper
 * mirror verifier-job sync subagent lifecycle 调用模板（phase 750 立）
 */
export async function runSpawnSync(opts: RunSpawnSyncOptions): Promise<ToolResult> {
  const id = `spawn-${randomUUID().slice(0, UUID_SHORT_LEN)}`;
  const resultDir = path.join(opts.ctx.clawDir, TASKS_SYNC_SPAWN_DIR, id);

  opts.ctx.auditWriter?.write(SPAWN_AUDIT_EVENTS.SYNC_STARTED, id, opts.intent.slice(0, AUDIT_PREVIEW_LEN));

  try {
    if (!opts.ctx.registry) {
      throw new Error('Tool registry not available in execution context');
    }
    if (!opts.ctx.llm) {
      throw new Error('LLM not available in execution context');
    }

    // mirror verifier-job 既有调用模板：从 caller registry 取 subagent profile 工具
    const subagentRegistry = createPerTaskRegistry(opts.ctx.registry, 'subagent');

    const { text, capturedResult } = await runSubagent({
      agentId: id,
      callerType: 'subagent',
      clawDir: opts.ctx.clawDir,
      fs: opts.ctx.fs,
      fsFactory: opts.ctx.fsFactory,
      llm: opts.ctx.llm,
      registry: subagentRegistry,
      prompt: opts.intent,
      systemPrompt: DEFAULT_SUBAGENT_SYSTEM_PROMPT,
      resultDir,
      maxSteps: opts.maxSteps ?? opts.ctx.subagentMaxSteps ?? opts.ctx.maxSteps,
      timeoutMs: opts.timeoutMs,
      isShadow: opts.ctx.isShadow,
      signal: opts.ctx.signal,
      toolTimeoutMs: opts.ctx.toolTimeoutMs,
      permissionChecker: opts.ctx.permissionChecker,
    });

    const content = getDisplayResult(text, capturedResult);
    opts.ctx.auditWriter?.write(SPAWN_AUDIT_EVENTS.SYNC_FINISHED, id);
    return {
      success: true,
      content,
      metadata: { spawnId: id, sync: true },
    };
  } catch (err) {
    const errMsg = formatErr(err);
    opts.ctx.auditWriter?.write(SPAWN_AUDIT_EVENTS.SYNC_FAILED, id, errMsg);
    return {
      success: false,
      content: `[clawforum spawn] sync execution failed: ${errMsg}`,
      error: 'spawn_sync_failed',
    };
  }
}
