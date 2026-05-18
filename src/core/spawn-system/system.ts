/**
 * spawn-system runtime helpers
 *
 * phase 766 Phase Y 加，封装 spawn 工具 sync 路径调用。
 * async 路径继续走 writePendingSubagentTaskFile（spawn.ts execute() 内直调）。
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ToolResult, ExecContext } from '../../foundation/tool-protocol/index.js';

import { UUID_SHORT_LEN } from '../../constants.js';
import { TASKS_SYNC_SPAWN_DIR } from './constants.js';
import { runSubagent, createDoneTool, DONE_TOOL_NAME } from '../subagent/index.js';
import { AUDIT_PREVIEW_LEN } from '../../foundation/audit/index.js';
import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../prompts/subagent.js';
import { SPAWN_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from './_helpers.js';
import { createToolRegistry } from '../../foundation/tools/index.js';

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
    const subagentRegistry = createToolRegistry();
    for (const tool of opts.ctx.registry.getForProfile('subagent')) {
      if (tool.name === DONE_TOOL_NAME) continue; // phase 944: skip main shared done (mirror phase 780)
      subagentRegistry.register(tool);
    }
    subagentRegistry.register(createDoneTool()); // fresh done instance per spawn run (mirror phase 780)

    const { text } = await runSubagent({
      agentId: id,
      callerType: 'subagent',
      callerClawId: opts.ctx.clawId,
      clawDir: opts.ctx.clawDir,
      fs: opts.ctx.fs,
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
    });

    opts.ctx.auditWriter?.write(SPAWN_AUDIT_EVENTS.SYNC_FINISHED, id);
    return {
      success: true,
      content: text,
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
