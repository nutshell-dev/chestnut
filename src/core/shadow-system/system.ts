/**
 * phase 767 NEW
 * shadow-system runtime helper，调用 runSubagent 同步阻塞
 * mirror verifier-job phase 750 加 spawn-system runSpawnSync phase 766 模板
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ToolResult, ExecContext } from '../../foundation/tool-protocol/index.js';
import type { Message } from '../../types/message.js';
import { TASKS_SYNC_SHADOW_DIR } from '../../types/paths.js';
import { UUID_SHORT_LEN } from '../../constants.js';
import { runSubagent } from '../subagent/index.js';
import { DialogStore } from '../../foundation/dialog-store/index.js';
import { DEFAULT_MAX_STEPS } from '../agent-executor/index.js';
import { SHADOW_AUDIT_EVENTS } from './audit-events.js';
import { synthesizeFormA, synthesizeFormB, formatErr } from './_helpers.js';
import type { BuildShadowInstructionArgs } from '../../prompts/shadow.js';
import { createToolRegistry } from '../../foundation/tools/index.js';

export interface RunShadowOptions {
  task: string;
  form: 'A' | 'B';
  timeoutMs?: number;
  maxSteps?: number;
  ctx: ExecContext;
}

export async function runShadow(opts: RunShadowOptions): Promise<ToolResult> {
  const shadowId = `shadow-${randomUUID().slice(0, UUID_SHORT_LEN)}`;
  const resultDir = path.join(opts.ctx.clawDir, TASKS_SYNC_SHADOW_DIR, shadowId);
  const spawnedAt = new Date().toISOString();

  opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.STARTED, shadowId, `form=${opts.form}`, opts.task.slice(0, 100));

  // 取 main session prefix（依 form 选 API）
  if (!opts.ctx.mainDialogStore || !opts.ctx.clawId || !opts.ctx.currentToolUseId) {
    return {
      success: false,
      content: '[clawforum shadow] missing main context (mainDialogStore, clawId, or currentToolUseId)',
      error: 'no_main_context',
    };
  }

  let synthesizedMessages: Message[];
  let restoredSystemPrompt: string;
  let restoredTools: import('../../types/message.js').ToolDefinition[];

  try {
    const marker = { clawId: opts.ctx.clawId, toolUseId: opts.ctx.currentToolUseId };
    const instructionArgs: BuildShadowInstructionArgs = {
      shadowId,
      spawnedAt,
      spawnedByClawId: opts.ctx.clawId,
      toolUseId: opts.ctx.currentToolUseId,
      task: opts.task,
      form: opts.form,
    };
    if (opts.form === 'A') {
      const restored = await opts.ctx.mainDialogStore.restorePrefix(marker);
      synthesizedMessages = synthesizeFormA({
        mainMessages: restored.messages,
        toolUseId: opts.ctx.currentToolUseId,
        instructionArgs,
      });
      restoredSystemPrompt = restored.systemPrompt;
      restoredTools = restored.toolsForLLM;
    } else {
      const restored = await opts.ctx.mainDialogStore.restoreBefore(marker);   // NEW API
      synthesizedMessages = synthesizeFormB({
        mainMessagesBeforeMarker: restored.messages,
        instructionArgs,
      });
      restoredSystemPrompt = restored.systemPrompt;
      restoredTools = restored.toolsForLLM;
    }
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.PREFIX_RESTORED, shadowId, `form=${opts.form}`);
  } catch (err) {
    const errMsg = formatErr(err);
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FAILED, shadowId, `prefix_restore_failed`, errMsg);
    return { success: false, content: `[clawforum shadow] prefix restore failed: ${errMsg}`, error: 'prefix_restore_failed' };
  }

  // shadow ctx 注入 isShadow=true（透传到所有工具 execute()）
  // shadow 用 full profile（C2 cache prefix 保护，mirror main agent 字节相同）
  try {
    if (!opts.ctx.registry) {
      throw new Error('Tool registry not available in execution context');
    }
    if (!opts.ctx.llm) {
      throw new Error('LLM not available in execution context');
    }

    const shadowRegistry = createToolRegistry();
    for (const tool of opts.ctx.registry.getForProfile('full')) {
      shadowRegistry.register(tool);
    }

    const { text, capturedResult } = await runSubagent({
      agentId: shadowId,
      callerType: 'subagent',
      callerClawId: opts.ctx.clawId,
      clawDir: opts.ctx.clawDir,
      fs: opts.ctx.fs,
      llm: opts.ctx.llm,
      registry: shadowRegistry,
      prompt: '',   // shadow 不用 prompt 字段（指令在 synthesized messages 末）
      systemPrompt: restoredSystemPrompt,
      messages: synthesizedMessages,
      resultDir,
      maxSteps: opts.maxSteps ?? opts.ctx.subagentMaxSteps ?? DEFAULT_MAX_STEPS,
      timeoutMs: opts.timeoutMs ?? 300_000,
      resultTool: 'done',
      isShadow: true,
    });

    const finalResult = (capturedResult as { result?: string } | undefined)?.result ?? text;
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FINISHED, shadowId);
    return {
      success: true,
      content: finalResult,
      metadata: { shadowId, form: opts.form, source: capturedResult ? 'done' : 'text' },
    };
  } catch (err) {
    const errMsg = formatErr(err);
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FAILED, shadowId, errMsg);
    return {
      success: false,
      content: `[clawforum shadow] execution failed: ${errMsg}`,
      error: classifyError(err),
      metadata: { shadowId, form: opts.form, shadowAuditPath: `${resultDir}/audit.tsv` },
    };
  }
}

function classifyError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'ToolTimeoutError') return 'timeout';
    if (err.name === 'LLMTimeoutError') return 'llm_idle_timeout';
  }
  return 'unknown';
}
