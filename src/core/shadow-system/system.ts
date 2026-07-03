/**
 * phase 767 NEW
 * shadow-system runtime helper，调用 runSubagent 同步阻塞
 * mirror verifier-job phase 750 加 spawn-system runSpawnSync phase 766 模板
 */

import * as path from 'path';
import { newShortUuid } from '../../foundation/node-utils/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { Message } from '../../foundation/llm-provider/index.js';
import type { StreamLog } from '../../foundation/stream/types.js';

import { TASKS_SYNC_SHADOW_DIR, SHADOW_DEFAULT_TIMEOUT_MS, SHADOW_TOOL_NAME } from './constants.js';
import { callerTypeToProfile } from '../permissions/caller-types.js';
import { runSubagent as defaultRunSubagent, createPerTaskRegistry, getDisplayResult, DONE_TOOL_NAME } from '../subagent/index.js';
import { SPAWN_TOOL_NAME } from '../spawn-system/tools/spawn.js';
import { SUMMON_TOOL_NAME } from '../summon-system/tools/summon.js';
import { NOTIFY_CLAW_TOOL_NAME } from '../claw-topology/tools/notify-claw.js';
import { EXEC_TOOL_NAME } from '../../foundation/command-tool/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';

import { SHADOW_AUDIT_EVENTS } from './audit-events.js';
import { synthesizeFormB, formatErr } from './_helpers.js';
import { classifyTaskError } from '../async-task-system/index.js';
// phase 691 Step C: deep import dirs.ts leaf (避 barrel cycle / 同 verifier-job 模式)
import { TASKS_SYNC_DIR } from '../async-task-system/dirs.js';
import type { BuildShadowInstructionArgs } from '../../templates/prompts/index.js';
import { type ToolUseId, makeToolUseId } from '../../foundation/tool-protocol/index.js';




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
    tools?: import('../../foundation/llm-provider/types.js').ToolDefinition[];
    messages?: Message[];
  };
  /** DI seam: optional runSubagent override (replaces vi.mock pattern) */
  runSubagent?: typeof defaultRunSubagent;
  mode?: 'v1' | 'v2';
  /** sync shadow 写 task_started 到主 stream，供 viewport 读取 */
  streamLog?: StreamLog;
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
  const shadowId = `shadow-${newShortUuid()}`;
  const resultDir = path.join(opts.ctx.clawDir, TASKS_SYNC_SHADOW_DIR, shadowId);
  const spawnedAt = new Date().toISOString();
  const mode = opts.mode ?? 'v1';

  const aw = opts.ctx.auditWriter;
  if (aw) {
    aw.write(SHADOW_AUDIT_EVENTS.STARTED, shadowId, aw.preview(opts.task));
  }

  const ts = opts.turnSnapshot;
  if (mode === 'v1') {
    // V1 validation: needs turnSnapshot
    if (
      !opts.ctx.clawId ||
      !opts.ctx.currentToolUseId ||
      ts?.systemPrompt === undefined ||
      ts?.tools === undefined
    ) {
      return {
        success: false,
        content:
          '[chestnut shadow] missing main agent in-memory state (clawId, currentToolUseId, systemPrompt, or tools)',
        error: 'no_main_context',
      };
    }
    if (!opts.mainMessages && !ts?.messages) {
      return {
        success: false,
        content: '[chestnut shadow] missing main agent in-memory state (dialogMessages)',
        error: 'no_main_context',
      };
    }
  } else {
    // V2 validation: needs clawId, currentToolUseId
    if (!opts.ctx.clawId || !opts.ctx.currentToolUseId) {
      return {
        success: false,
        content:
          '[chestnut shadow] missing main agent in-memory state (clawId or currentToolUseId)',
        error: 'no_main_context',
      };
    }
  }

  const restoredSystemPrompt: string = mode === 'v1' ? ts!.systemPrompt! : (ts?.systemPrompt ?? '');

  let synthesizedMessages: Message[];

  try {
    if (mode === 'v2') {
      // V2: messages 已由 caller 组装（含 shadow() tool_use + synthetic tool_result）
      synthesizedMessages = [...opts.mainMessages!];
    } else {
      // V1: existing behavior — find marker, strip, synthesizeFormB
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
        mode: 'v1',
      });
    }
    // phase 712: raw shadowId 加 key= prefix
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.PREFIX_RESTORED, `shadowId=${shadowId}`);
  } catch (err) {
    const errMsg = formatErr(err);
    // phase 712: raw cols 加 key= prefix + phase= 标识失败阶段
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FAILED, `shadowId=${shadowId}`, `phase=prefix_restore`, `error=${errMsg}`);
    return { success: false, content: `[chestnut shadow] prefix synthesis failed: ${errMsg}`, error: 'prefix_synthesis_failed' };
  }

  // shadow ctx 注入 isShadow=true（透传到所有工具 execute()）
  // shadow 用 full profile（C2 cache prefix 保护，mirror main agent 字节相同）
  let forwardStream: StreamLog | undefined;
  try {
    if (mode === 'v2') {
      // Forward shadow stream events to main stream for viewport display.
      // tool_call 加 shadow: 前缀；tool_result 加 shadow:result 前缀；text_delta 透传；其余事件不转发以减少主 stream 噪声。
      forwardStream = opts.streamLog ? {
        write(event) {
          if (event.type === 'tool_call' && event.name) {
            opts.streamLog!.write({ ...event, name: `shadow:${String(event.name)}` });
          } else if (event.type === 'tool_result') {
            opts.streamLog!.write({
              ...event,
              name: `shadow:result`,
            });
          } else if (event.type === 'text_delta') {
            opts.streamLog!.write(event);
          }
        },
      } : undefined;
    }

    const baseRegistry = opts.ctx.baseRegistry ?? opts.ctx.registry;
    if (!baseRegistry) {
      throw new Error('Tool registry not available in execution context');
    }
    if (!opts.ctx.registry) {
      throw new Error('Main tool registry not available in execution context');
    }
    if (!opts.ctx.llm) {
      throw new Error('LLM not available in execution context');
    }

    const shadowRegistry = createPerTaskRegistry(baseRegistry, 'full');

    // Phase 807: 覆盖 shadow registry 中的限制版工具，ToolDefinition 不变、KV cache 命中。
    // 通过 clone + 改 DI 属性实现；execute 内读取 this.DI_FIELD。
    // Phase 811: 从 mainRegistry 取受限工具（baseRegistry 只含基础工具）
    const mainRegistry = opts.ctx.registry;
    overrideRestrictedTool(shadowRegistry, mainRegistry, SHADOW_TOOL_NAME, { allowRecursion: false });
    overrideRestrictedTool(shadowRegistry, mainRegistry, SPAWN_TOOL_NAME, { allowAsync: false });
    overrideRestrictedTool(shadowRegistry, mainRegistry, SUMMON_TOOL_NAME, { allowFromShadow: false });
    overrideRestrictedTool(shadowRegistry, mainRegistry, NOTIFY_CLAW_TOOL_NAME, { authorized: false });
    overrideRestrictedTool(shadowRegistry, mainRegistry, EXEC_TOOL_NAME, { callerType: 'shadow' });

    const { text, capturedResult } = await (opts.runSubagent ?? defaultRunSubagent)({
      agentId: shadowId,
      toolProfile: callerTypeToProfile('shadow'),
      clawDir: opts.ctx.clawDir,
      fs: opts.ctx.fs,
      fsFactory: opts.ctx.fsFactory,
      llm: opts.ctx.llm,
      registry: shadowRegistry,
      prompt: '',   // shadow 不用 prompt 字段（指令在 synthesized messages 末）
      systemPrompt: restoredSystemPrompt,
      messages: synthesizedMessages,
      resultDir,
      syncDir: path.join(opts.ctx.clawDir, TASKS_SYNC_DIR),
      maxSteps: opts.maxSteps,
      timeoutMs: opts.timeoutMs ?? SHADOW_DEFAULT_TIMEOUT_MS,
      // phase 369 §4 (review-2026-06-13): 用 const、tool 重命名时 shadow-system 跟住
      resultTool: DONE_TOOL_NAME,
      isShadow: true,
      // phase 1162 r128 D fork DD2: shadow 独立 lifecycle (phase 1084 ratify 维持)。
      // 显式不传 signal 字段而非 fake `new AbortController().signal` (M#9 显式表达 / honesty fix)。
      // ratify chain: phase 874 (α-propagate) → phase 1084 (β-independent fake AC) → phase 1162 (β-independent honest omit)。
      permissionChecker: opts.ctx.permissionChecker,
      forwardStream,
    });

    const finalResult = getDisplayResult(text, capturedResult);
    // phase 712: raw shadowId 加 key= prefix
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FINISHED, `shadowId=${shadowId}`);
    return {
      success: true,
      content: finalResult,
      metadata: { shadowId, source: capturedResult ? 'done' : 'text' },
    };
  } catch (err) {
    const errMsg = formatErr(err);
    // phase 712: raw cols 加 key= prefix
    opts.ctx.auditWriter?.write(SHADOW_AUDIT_EVENTS.FAILED, `shadowId=${shadowId}`, `error=${errMsg}`);
    return {
      success: false,
      content: `[chestnut shadow] execution failed: ${errMsg}`,
      error: classifyTaskError(err),
      metadata: { shadowId, shadowAuditPath: `${resultDir}/audit.tsv` },
    };
  }
}

/**
 * Phase 807: clone a tool from baseRegistry into targetRegistry with overridden DI properties.
 * Preserves prototype chain (works for both object-literal and class-based Tools) and
 * leaves ToolDefinition unchanged so KV cache stays stable.
 */
function overrideRestrictedTool(
  targetRegistry: ToolRegistry,
  baseRegistry: ToolRegistry,
  name: string,
  diOverrides: Record<string, unknown>,
): void {
  const baseTool = baseRegistry.get(name);
  if (!baseTool) return;
  const restricted = Object.assign(Object.create(Object.getPrototypeOf(baseTool)), baseTool, diOverrides);
  targetRegistry.register(restricted);
}

