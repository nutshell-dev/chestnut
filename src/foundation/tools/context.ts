/**
 * ExecContextImpl - Execution context implementation
 * 
 * Provides context for tool execution including:
 * - Identity (clawId, clawDir)
 * - Permissions based on tool profile
 * - Dependencies (fs, llm)
 * - Execution tracking (stepNumber, elapsed time)
 */

import type { FileSystem } from '../fs/types.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { ToolProfile } from '../../types/config.js';
import type { ExecContext } from '../tool-protocol/index.js';
import path from 'path';
import { MOTION_CLAW_ID } from '../../constants.js';
import { CLAWSPACE_DIR } from '../../types/paths.js';


import type { Message, ToolDefinition } from '../../types/message.js';
import type { AuditLog } from '../audit/index.js';
import type { CallerType } from '../tool-protocol/caller-type.js';
import type { DialogStore } from '../dialog-store/index.js';
import type { ToolRegistry } from './types.js';
import type { PermissionChecker } from '../../types/permission.js';

/**
 * Options for creating execution context
 */
export interface ExecContextImplOptions {
  /** Claw identifier */
  clawId: string;
  
  /** Claw workspace directory */
  clawDir: string;
  
  /** phase 509 / 可选 / 默认 fallback = path.join(clawDir, CLAWSPACE_DIR) */
  workspaceDir?: string;

  /** phase 514 / subagent caller's clawId / 装配方注入 */
  callerClawId?: string;
  
  /** 装配-level 共享 sync dir（兜底落盘 + FileTool write_backups 共用 / 应然 §A.7） */
  syncDir: string;
  
  /** Tool profile for permission control */
  profile: ToolProfile;
  
  /** Caller type for spawn recursion prevention */
  callerType?: CallerType;
  
  /** File system instance */
  fs: FileSystem;
  
  /** Optional LLM service */
  llm?: LLMOrchestrator;
  
  /** Maximum allowed steps (ReAct loop limit) */
  maxSteps: number;
  
  /** Optional abort signal */
  signal?: AbortSignal;
  
  
  
  /** Max steps for subagents created via spawn tool */
  subagentMaxSteps?: number;
  
  
  /** 当前对话 messages（供 dispatch 工具读取） */
  dialogMessages?: Message[];
  /** 创建链路的源头 clawId，由 dispatch/spawn 传播 */
  originClawId?: string;
  /** AuditLog writer for tool events */
  auditWriter?: AuditLog;
  /** Main dialog store (subagent profile only / ask_caller read-only ref) */
  mainDialogStore?: DialogStore;
  /** Marker for restoring main context prefix via DialogStore.restorePrefix */
  mainContextSnapshot?: { clawId: string; toolUseId: string };
  /** Current tool_use block id (set by ToolExecutor before tool.execute) */
  currentToolUseId?: string;
  /** Session-scoped fully-read paths（read 未截断时 add / overwrite gate / phase 487 G6） */
  fullyReadPaths?: Set<string>;
  /** Tool registry reference for sync spawn path (phase 766) */
  registry?: ToolRegistry;
  /** Whether this context belongs to a shadow agent (phase 766 prep for 767) */
  isShadow?: boolean;
  /** Assembly-injected per-claw permission checker (replaces module-level factory pattern, phase 1006) */
  permissionChecker?: PermissionChecker;
  /** Current main agent turn's systemPrompt (in-memory, set by runtime before runReact) — phase 769 */
  systemPromptForLLM?: string;
  /** Current main agent turn's tools array (in-memory, set by runtime before runReact) — phase 769 */
  toolsForLLM?: ToolDefinition[];
  /** Tool-level wall-clock timeout, inherited from globalConfig.tool_timeout_ms / Assembly 装配期注入 (phase 1029 / F-2) */
  toolTimeoutMs?: number;
}

/**
 * Clone an ExecContext while preserving prototype chain.
 *
 * Object spread `{ ...ctx, ... }` only copies own enumerable properties,
 * losing class methods/getters from ExecContextImpl (`isMotionChain`,
 * `getElapsedMs`, `incrementStep`). This helper preserves them.
 *
 * Works for both class instances (ExecContextImpl) and plain object mocks
 * (test fixtures) — falls back to Object.prototype when `ctx` has no class.
 */
export function cloneExecContext(
  ctx: ExecContext,
  overrides: Partial<ExecContext>,
): ExecContext {
  const proto = Object.getPrototypeOf(ctx) ?? Object.prototype;
  const clone = Object.create(proto);
  Object.assign(clone, ctx, overrides);
  clone.permissionChecker = ctx.permissionChecker;
  // phase 778: stopRequested 加 requestStop 委托回 parent ctx。
  // 否则 Object.assign 复制 primitive false 到 clone / mutator 写 clone storage /
  // runAgent 读原 ctx 仍 false / loop 不退。
  // phase 929 (r116 G fork): getter 加 `?? false` fallback — 与下方 requestStop typeof guard
  // 对称 / fixture (plain object mock) 缺 stopRequested 字段时返 false 非 undefined。
  // ExecContextImpl 永 init stopRequested=false / 真生产 0 触发、仅 fixture defense 一致性。
  Object.defineProperty(clone, 'stopRequested', {
    get() { return ctx.stopRequested ?? false; },
    set(v) { (ctx as { stopRequested: boolean }).stopRequested = v; },
    configurable: true,
  });
  // phase 815 P1.32: fixture defense — function 自身契约支持 plain object mocks（line 99-100 注释明示），
  // 但 ctx.requestStop 可能 undefined（fixture 漏定义）/ stopRequested getter 同型 fallback (phase 929)、
  // requestStop typeof guard。0 行为变实然 path（真 ctx 永有 method）。
  clone.requestStop = () => {
    if (typeof ctx.requestStop === 'function') ctx.requestStop();
  };
  return clone;
}

/**
 * Execution context implementation
 */
export class ExecContextImpl implements ExecContext {
  clawId: string;
  clawDir: string;
  workspaceDir: string;
  callerClawId?: string;
  syncDir: string;
  profile: ToolProfile;
  callerType: CallerType;
  fs: FileSystem;
  llm?: LLMOrchestrator;
  stepNumber: number;
  maxSteps: number;
  signal?: AbortSignal;
  subagentMaxSteps: number;
  dialogMessages?: Message[];
  originClawId?: string;
  auditWriter?: AuditLog;
  mainDialogStore?: DialogStore;
  mainContextSnapshot?: { clawId: string; toolUseId: string };
  currentToolUseId?: string;
  fullyReadPaths: Set<string>;
  registry?: ToolRegistry;
  isShadow?: boolean;
  systemPromptForLLM?: string;
  toolsForLLM?: ToolDefinition[];
  permissionChecker?: PermissionChecker;
  toolTimeoutMs?: number;
  stopRequested: boolean = false;
  
  private startTime: number;

  constructor(options: ExecContextImplOptions) {
    this.clawId = options.clawId;
    this.clawDir = options.clawDir;
    this.workspaceDir = options.workspaceDir ?? path.join(options.clawDir, CLAWSPACE_DIR);
    this.callerClawId = options.callerClawId;
    this.syncDir = options.syncDir;
    this.profile = options.profile;
    this.callerType = options.callerType ?? 'claw';
    this.fs = options.fs;
    this.llm = options.llm;
    this.maxSteps = options.maxSteps;
    this.signal = options.signal;
    this.subagentMaxSteps = options.subagentMaxSteps ?? options.maxSteps;
    this.dialogMessages = options.dialogMessages;
    this.originClawId = options.originClawId;
    this.auditWriter = options.auditWriter;
    this.mainDialogStore = options.mainDialogStore;
    this.mainContextSnapshot = options.mainContextSnapshot;
    this.currentToolUseId = options.currentToolUseId;
    this.fullyReadPaths = options.fullyReadPaths ?? new Set();
    this.registry = options.registry;
    this.isShadow = options.isShadow;
    this.systemPromptForLLM = options.systemPromptForLLM;
    this.toolsForLLM = options.toolsForLLM;
    this.permissionChecker = options.permissionChecker;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.stepNumber = 0;
    this.startTime = Date.now();
  }

  /**
   * 是否为 Motion 创建链路上的 agent（Motion 本体或其 subagent）
   */
  get isMotionChain(): boolean {
    return this.clawId === MOTION_CLAW_ID || this.originClawId === MOTION_CLAW_ID;
  }

  /**
   * Get elapsed time since context creation
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Increment step counter
   * Called by ReAct loop before each step
   */
  incrementStep(): void {
    this.stepNumber++;
  }

  /**
   * phase 777: called by result-capture tools (done, report_result) after storing capturedResult.
   * AgentExecutor reads stopRequested at the top of its loop and exits cleanly, saving the
   * next LLM round-trip.
   */
  requestStop(): void {
    this.stopRequested = true;
    this.auditWriter?.write('stop_requested', `clawId=${this.clawId}`, `step=${this.stepNumber}`);
  }

}
