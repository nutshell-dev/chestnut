/**
 * phase 767 NEW
 * shadow-system runtime helper，调用 runSubagent 同步阻塞
 * mirror verifier-job phase 750 加 spawn-system runSpawnSync phase 766 模板
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { Message } from '../../foundation/llm-provider/types.js';

import { UUID_SHORT_LEN } from '../../constants.js';
import { TASKS_SYNC_SHADOW_DIR } from './constants.js';
import { runSubagent, createPerTaskRegistry, getDisplayResult } from '../subagent/index.js';
import { AUDIT_PREVIEW_LEN } from '../../foundation/constants.js';
import { SHADOW_AUDIT_EVENTS } from './audit-events.js';
import { synthesizeFormB, formatErr } from './_helpers.js';
import { classifyTaskError } from '../async-task-system/index.js';
import type { BuildShadowInstructionArgs } from '../../prompts/index.js';
import { type ToolUseId, makeToolUseId } from '../../foundation/tool-protocol/index.js';




export interface RunShadowOptions {
  task: string;
  timeoutMs?: number;
  maxSteps?: number;
  ctx: ExecContext;
  /** Pre-stripped main agent messages (shadow.ts already removed incomplete tool_use) */
  mainMessages?: Message[];
  /** L4 turn state snapshot — injected by shadow tool factory (not from ctx) */
  turnSnapshot?: {
    systemPrompt?: string;
    tools?: import('../../foundation/llm-provider/types.js').ToolDefinition[];
    messages?: Message[];
  };
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

export async function runShadow(opts: RunShadowOptions): Promise<ToolResult> {
  const shadowId = `shadow-${randomUUID().slice(0, UUID_SHORT_LEN)}`;
  const resultDir = path.join(opts.ctx.clawDir, TASKS_SYNC_SHADOW_DIR, shadowId);
  const spawnedAt = new Date().toISOString();

  opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.STARTED, shadowId, opts.task.slice(0, AUDIT_PREVIEW_LEN));

  const ts = opts.turnSnapshot;
  // 取 main session in-memory 状态（phase 769：改读 ctx，不读 DialogStore 磁盘，避 sync 时序 bug）
  if (
    !opts.ctx.clawId ||
    !opts.ctx.currentToolUseId ||
    ts?.systemPrompt === undefined ||
    ts?.tools === undefined
  ) {
    return {
      success: false,
      content:
        '[clawforum shadow] missing main agent in-memory state (clawId, currentToolUseId, systemPrompt, or tools)',
      error: 'no_main_context',
    };
  }
  if (!opts.mainMessages && !ts?.messages) {
    return {
      success: false,
      content: '[clawforum shadow] missing main agent in-memory state (dialogMessages)',
      error: 'no_main_context',
    };
  }

  const mainMessages = opts.mainMessages ?? ts.messages!;
  const restoredSystemPrompt = ts.systemPrompt;

  let synthesizedMessages: Message[];

  try {
    const instructionArgs: Omit<BuildShadowInstructionArgs, 'shadowToolName'> = {
      shadowId,
      spawnedAt,
      spawnedByClawId: opts.ctx.clawId,
      toolUseId: makeToolUseId(opts.ctx.currentToolUseId),
      task: opts.task,
    };
    // pre-stripped by shadow.ts → already before the marker. Otherwise find + slice.
    const mainMessagesBeforeMarker = opts.mainMessages
      ?? (() => {
        const idx = findLastAssistantWithToolUse(mainMessages, makeToolUseId(opts.ctx.currentToolUseId));
        if (idx < 0) throw new Error(`marker not found: ${opts.ctx.currentToolUseId}`);
        return mainMessages.slice(0, idx);
      })();
    synthesizedMessages = synthesizeFormB({
      mainMessagesBeforeMarker,
      instructionArgs,
    });
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.PREFIX_RESTORED, shadowId);
  } catch (err) {
    const errMsg = formatErr(err);
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FAILED, shadowId, 'prefix_restore_failed', errMsg);
    return { success: false, content: `[clawforum shadow] prefix synthesis failed: ${errMsg}`, error: 'prefix_synthesis_failed' };
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

    const shadowRegistry = createPerTaskRegistry(opts.ctx.registry, 'full');

    const { text, capturedResult } = await runSubagent({
      agentId: shadowId,
      callerType: 'shadow',
      clawDir: opts.ctx.clawDir,
      fs: opts.ctx.fs,
      fsFactory: opts.ctx.fsFactory,
      llm: opts.ctx.llm,
      registry: shadowRegistry,
      prompt: '',   // shadow 不用 prompt 字段（指令在 synthesized messages 末）
      systemPrompt: restoredSystemPrompt,
      messages: synthesizedMessages,
      resultDir,
      maxSteps: opts.maxSteps ?? opts.ctx.subagentMaxSteps ?? opts.ctx.maxSteps,
      timeoutMs: opts.timeoutMs ?? 300_000,
      resultTool: 'done',
      isShadow: true,
      // phase 1162 r128 D fork DD2: shadow 独立 lifecycle (phase 1084 ratify 维持)。
      // 显式不传 signal 字段而非 fake `new AbortController().signal` (ML#9 显式表达 / honesty fix)。
      // ratify chain: phase 874 (α-propagate) → phase 1084 (β-independent fake AC) → phase 1162 (β-independent honest omit)。
      permissionChecker: opts.ctx.permissionChecker,
    });

    const finalResult = getDisplayResult(text, capturedResult);
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FINISHED, shadowId);
    return {
      success: true,
      content: finalResult,
      metadata: { shadowId, source: capturedResult ? 'done' : 'text' },
    };
  } catch (err) {
    const errMsg = formatErr(err);
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FAILED, shadowId, errMsg);
    return {
      success: false,
      content: `[clawforum shadow] execution failed: ${errMsg}`,
      error: classifyTaskError(err),
      metadata: { shadowId, shadowAuditPath: `${resultDir}/audit.tsv` },
    };
  }
}

