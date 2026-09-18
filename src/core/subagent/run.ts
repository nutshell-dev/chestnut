// src/core/subagent/run.ts
/**
 * runSubagent — sync subagent lifecycle helper
 * phase 750 NEW、SubAgent 模块自治 sync subagent runtime + cleanup
 * mirror async path src/core/async-task-system/subagent-executor.ts 模板简化版
 *
 * Caller 接口面最小化（M#8）：传业务 params、不传 audit/stream/workspace 基础设施细节
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { createAuditWriter } from '../../foundation/audit/index.js';
import { makeTraceId, type TraceId } from '../../foundation/audit/index.js';
import { formatErr, randomHex } from '../../foundation/node-utils/index.js';
import { STREAM_FILE, createPerResourceStreamWriter, type StreamEvent } from '../../foundation/stream/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import { ToolExecutor, type ToolRegistry } from '../../foundation/tools/index.js';
// createToolRegistry removed — caller owns registry assembly (M#1 align)
import type { ToolDefinition } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import { createDialogStore } from '../../foundation/dialog-store/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
// phase 691 Step C / phase 1488: removed import of TASKS_SYNC_DIR from async-task-system.
// TASKS_SYNC_DIR namespace name is now owned by ClawIdentity; L3 SubAgent must not depend on L4 AsyncTaskSystem (M#5). syncDir 现 caller DI、见 RunSubagentOptions.
import type { PermissionChecker, ToolProfile } from '../../foundation/tool-protocol/index.js';
import { SubAgent, type DegradedArtifact } from './agent.js';
import { DONE_TOOL_NAME, createResultCaptureChannel } from './tools/done.js';
import { bindRunCapture } from './registry-helper.js';

export interface RunSubagentOptions {
  // 标识
  agentId: string;

  // 权限注入（caller 计算后传入）
  toolProfile?: ToolProfile;

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

  // phase 691 Step C / phase 1488: caller 计算 path.join(clawDir, TASKS_SYNC_DIR) 后注入。
  // TASKS_SYNC_DIR 为 ClawIdentity 持有的中性 namespace 名称；L3 SubAgent 不 own 该常量（M#5 严守）。
  // ToolExecutor 需要 syncDir 用于 file-tool 同 claw 沙箱内的 sync workspace 子目录解析。
  syncDir: string;

  // 行为参数（per phase 747 ctor required 模板）
  // phase 1490: maxSteps optional / undefined → SubAgent boundary fallback to DEFAULT_MAX_STEPS
  maxSteps?: number;
  idleTimeoutMs?: number;

  // optional
  signal?: AbortSignal;
  timeoutMs?: number;           // whole-task timeout（async caller 用、verifier 用 idleTimeoutMs only）
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
  /** Parent trace when available; otherwise runSubagent creates a durable run trace. */
  traceId?: TraceId;
  /** Business contract correlation when this subagent verifies a contract. */
  currentContractId?: string;

}

export interface RunSubagentResult {
  text: string;
  capturedResult?: unknown;
  /**
   * phase 1858 Step G (SA-D6): 持久化/结算降级证据（哪些 artifact、何阶段失败）。
   * best-effort 写点失败不改变执行结果，但必须可见；全成功时缺省。
   */
  degraded?: DegradedArtifact[];
}

/**
 * phase 1858 Step E (SA-D4): terminal outcome 前无法可靠 join 时的「已收敛 / 仍运行」typed 证据。
 *
 * race 失败（timeout/abort 胜出）→ agent.run() 有界等待 runReact settle：
 * 窗口内收敛 → `subagentStillRunning: false`；超窗仍未收敛 → `true`（仍可能继续产生
 * 工具副作用）+ audit 留证。证据随上抛错误对象移交 owner（ATS/verifier/shadow）处置。
 */
export interface SubagentStillRunningEvidence {
  subagentStillRunning: boolean;
}

export function getSubagentStillRunning(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as Partial<SubagentStillRunningEvidence>).subagentStillRunning === true;
}

export async function runSubagent(opts: RunSubagentOptions): Promise<RunSubagentResult> {
  await opts.fs.ensureDir(opts.resultDir);

  // audit 自治创建（caller 不传基础设施 writer、M#8 接口最小）
  // stream 走 L2 createPerResourceStreamWriter（M#3 stream 物理格式归 L2、phase 1116）
  const auditWriter = createAuditWriter(opts.fs, `${opts.resultDir}/audit.tsv`);
  const traceId = opts.traceId ?? makeTraceId(randomHex(8));
  const streamPath = `${opts.resultDir}/${STREAM_FILE}`;
  const baseStreamWriter = createPerResourceStreamWriter(opts.fs, streamPath, auditWriter);
  const taskStreamWriter = {
    write: (event: Record<string, unknown>): void => {
      const tsEvent = { ts: Date.now(), ...event } as StreamEvent;
      baseStreamWriter.write(tsEvent);
    },
  };

  // dialog store
  const messageStore = createDialogStore(opts.fs, opts.resultDir, auditWriter, 'messages.json');

  // phase 1858 Step F (SA-D5): 每 run 独占 capture channel；registry 视图把 DONE tool 条目
  // 绑定到本 run 通道（caller registry 不被修改）——结果由执行侧写入、本 helper 直接读取。
  const capture = createResultCaptureChannel<{ result: string }>();
  const runRegistry = bindRunCapture(opts.registry, capture);

  // tools for LLM — caller 可 override；默认用 registry 全量（caller 已负责 profile filter）
  const toolsForLLM = opts.toolsForLLM ?? runRegistry.formatForLLM(runRegistry.getAll());

  // workspace shared with caller workspaceDir 路径决策（mirror async / verifier 既有 phase 518 决策）
  const sharedWorkspaceDir = path.join(opts.clawDir, CLAWSPACE_DIR);

  // phase 1489 (M#8 derive): caller (run.ts) own ToolExecutor 构造、SubAgent 不再 own
  // 7 个 executor-only 字段、SubAgentOptions 收窄到「SubAgent 自身真正需要的」最小集合。
  const toolExecutor = new ToolExecutor({
    registry: runRegistry,
    defaultTimeoutMs: opts.toolTimeoutMs,
    clawDir: opts.clawDir,
    syncDir: opts.syncDir,
    workspaceDir: sharedWorkspaceDir,
    fs: opts.fs,
    fsFactory: opts.fsFactory,
    llm: opts.llm,
    auditWriter,
  });

  const agent = new SubAgent({
    agentId: opts.agentId,
    resultDir: opts.resultDir,
    messageStore,
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    toolExecutor,
    llm: opts.llm,
    registry: runRegistry,
    fs: opts.fs,
    maxSteps: opts.maxSteps,
    idleTimeoutMs: opts.idleTimeoutMs,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    toolsForLLM,
    toolProfile: opts.toolProfile,
    onIdleTimeout: opts.onIdleTimeout,
    taskStreamWriter,
    auditWriter,
    traceId,
    currentContractId: opts.currentContractId,
    messages: opts.messages,
    isShadow: opts.isShadow,
    permissionChecker: opts.permissionChecker,
  });

  let text: string;
  try {
    text = await agent.run();
  } catch (err) {
    // phase 1858 Step G (SA-D6): 失败路径透传——降级证据随错误对象移交 owner（同 Step E 承载模式）
    const degraded = agent.getDegradedArtifacts();
    if (degraded.length > 0) {
      const carrier = typeof err === 'object' && err !== null ? err : new Error(formatErr(err));
      Object.assign(carrier, { degraded: [...degraded] });
      throw carrier;
    }
    throw err;
  }

  // 检 capturedResult（verifier 等用 / phase 765 扩 resultTool option）
  // phase 805 设计意图：by-name string 0 import (避 L3→L4 反向 import / mirror shadow-system/system.ts:129 'done')
  // phase 1056: default 改为 DONE_TOOL_NAME — done 是单一 result-capture 工具。
  // phase 1858 Step F (SA-D5): 主路径（DONE_TOOL_NAME）读本 run 独占通道；
  // 自定义 resultTool 名（无生产调用方的遗留 seam）保留按名读取——其捕获机制不在本模块职责内。
  const toolName = opts.resultTool ?? DONE_TOOL_NAME;
  const capturedResult = toolName === DONE_TOOL_NAME
    ? capture.get()
    : (opts.registry.get(toolName) as { capturedResult?: unknown } | undefined)?.capturedResult;

  // phase 1858 Step G (SA-D6): 降级证据并入 typed outcome（成功路径）
  const degraded = agent.getDegradedArtifacts();
  return { text, capturedResult, degraded: degraded.length > 0 ? [...degraded] : undefined };
}

// caller 负责 registry 装配（含 profile filter + 特殊工具如 done）
// runSubagent 只 own audit/stream/workspace/dialog store lifecycle

/**
 * phase 1091: 统一 capturedResult 读取，消除 3 处重复 cast
 */
export function getDisplayResult(text: string, capturedResult?: unknown): string {
  return (capturedResult as { result?: string } | undefined)?.result ?? text;
}
