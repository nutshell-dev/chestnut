// src/core/subagent/run.ts
/**
 * runSubagent — sync subagent lifecycle helper
 * phase 750 NEW、SubAgent 模块自治 sync subagent runtime + cleanup
 * mirror async path src/core/async-task-system/subagent-executor.ts 模板简化版
 *
 * Caller 接口面最小化（M#8）：传业务 params、不传 audit/stream/workspace 基础设施细节
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { createAuditWriter } from '../../foundation/audit/index.js';
import { STREAM_FILE, createPerResourceStreamWriter, type StreamEvent } from '../../foundation/stream/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
// createToolRegistry removed — caller owns registry assembly (M#1 align)
import type { Message, ToolDefinition } from '../../foundation/llm-provider/types.js';
import type { CallerType } from '../caller-types.js';
import { createDialogStore } from '../../foundation/dialog-store/index.js';
import { CLAWSPACE_DIR } from '../../foundation/paths.js';
import type { PermissionChecker } from '../../foundation/tool-protocol/permission.js';

import { SubAgent } from './agent.js';
import { DONE_TOOL_NAME } from './tools/done.js';
import type { ClawId } from '../../foundation/identity/index.js';
import type { ToolUseId } from '../../foundation/tool-protocol/index.js';



export interface MainContextSnapshot {
  clawId: ClawId;
  toolUseId: ToolUseId;
}

export interface RunSubagentOptions {
  // 标识
  agentId: string;
  callerType?: CallerType;

  // 基础设施依赖（caller 注入）
  clawDir: string;
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  llm: LLMOrchestrator;
  registry: ToolRegistry;

  // 任务
  prompt: string;
  systemPrompt: string;

  // 持久化位置（caller own resource path、如 'tasks/sync/subagent/<id>'）
  resultDir: string;

  // 行为参数（per phase 747 ctor required 模板）
  maxSteps: number;
  idleTimeoutMs?: number;

  // optional
  signal?: AbortSignal;
  timeoutMs?: number;           // whole-task timeout（async caller 用、verifier 用 idleTimeoutMs only）
  originClawId?: string;        // summon chain trace（async caller 用）
  toolsForLLM?: ToolDefinition[];
  onIdleTimeout?: () => void;

  // NEW (phase 765)：取 capturedResult 用的 tool name / default DONE_TOOL_NAME (phase 1056)
  resultTool?: string;

  // NEW (phase 767)：shadow 需要传完整合成 messages
  messages?: Message[];
  isShadow?: boolean;

  // NEW (phase 1029 / F-2)：tool-level timeout inheritance from caller ExecContext
  toolTimeoutMs?: number;
  permissionChecker?: PermissionChecker;

}

export interface RunSubagentResult {
  text: string;
  capturedResult?: unknown;
}

export async function runSubagent(opts: RunSubagentOptions): Promise<RunSubagentResult> {
  await opts.fs.ensureDir(opts.resultDir);

  // audit 自治创建（caller 不传基础设施 writer、ML#8 接口最小）
  // stream 走 L2 createPerResourceStreamWriter（ML#3 stream 物理格式归 L2、phase 1116）
  const auditWriter = createAuditWriter(opts.fs, `${opts.resultDir}/audit.tsv`);
  const streamPath = `${opts.resultDir}/${STREAM_FILE}`;
  const baseStreamWriter = createPerResourceStreamWriter(opts.fs, streamPath, auditWriter);
  const taskStreamWriter = {
    write: (event: Record<string, unknown>): void => {
      baseStreamWriter.write({ ts: Date.now(), ...event } as StreamEvent);
    },
  };

  // dialog store
  const messageStore = createDialogStore(opts.fs, opts.resultDir, auditWriter, 'messages.json');

  // tools for LLM — caller 可 override；默认用 registry 全量（caller 已负责 profile filter）
  const toolsForLLM = opts.toolsForLLM ?? opts.registry.formatForLLM(opts.registry.getAll());

  // workspace shared with caller workspaceDir 路径决策（mirror async / verifier 既有 phase 518 决策）
  const sharedWorkspaceDir = path.join(opts.clawDir, CLAWSPACE_DIR);

  const agent = new SubAgent({
    agentId: opts.agentId,
    resultDir: opts.resultDir,
    messageStore,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    clawDir: opts.clawDir,
    syncDir: path.join(opts.clawDir, 'tasks/sync'),  // TASKS_SYNC_DIR
    llm: opts.llm,
    registry: opts.registry,
    fs: opts.fs,
    fsFactory: opts.fsFactory,
    maxSteps: opts.maxSteps,
    idleTimeoutMs: opts.idleTimeoutMs,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    toolsForLLM,
    callerType: opts.callerType,
    originClawId: opts.originClawId,
onIdleTimeout: opts.onIdleTimeout,
    workspaceDir: sharedWorkspaceDir,
    taskStreamWriter,
    auditWriter,
    messages: opts.messages,
    isShadow: opts.isShadow,
    toolTimeoutMs: opts.toolTimeoutMs,
    permissionChecker: opts.permissionChecker,
  });

  const text = await agent.run();

  // 检 capturedResult（verifier 等用 / phase 765 扩 resultTool option）
  // phase 805 设计意图：by-name string 0 import (避 L3→L4 反向 import / mirror shadow-system/system.ts:129 'done')
  // phase 1056: default 改为 DONE_TOOL_NAME — done 是单一 result-capture 工具。
  const toolName = opts.resultTool ?? DONE_TOOL_NAME;
  const resultToolInstance = opts.registry.get(toolName);
  const capturedResult = (resultToolInstance as { capturedResult?: unknown })?.capturedResult;

  return { text, capturedResult };
}

// caller 负责 registry 装配（含 profile filter + 特殊工具如 done）
// runSubagent 只 own audit/stream/workspace/dialog store lifecycle

/**
 * phase 1091: 统一 capturedResult 读取，消除 3 处重复 cast
 */
export function getDisplayResult(text: string, capturedResult?: unknown): string {
  return (capturedResult as { result?: string } | undefined)?.result ?? text;
}
