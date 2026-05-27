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
import type { ToolProfile } from '../tool-protocol/index.js';
import type { ExecContext, ToolGroup } from './types.js';
import path from 'path';
import { MOTION_CLAW_ID } from '../../constants.js';
import { CLAWSPACE_DIR } from '../paths.js';


import type { AuditLog } from '../audit/index.js';

import type { ToolRegistry } from './types.js';
import type { PermissionChecker } from '../tool-protocol/permission.js';
import type { ClawId } from '../identity/index.js';
import { type ClawDir } from '../identity/index.js';


/**
 * Options for creating execution context
 */
export interface ExecContextImplOptions {
  /** Claw identifier */
  clawId: ClawId;
  
  /** Claw workspace directory */
  clawDir: ClawDir;
  
  /** phase 509 / 可选 / 默认 fallback = path.join(clawDir, CLAWSPACE_DIR) */
  workspaceDir?: string;

  /** 装配-level 共享 sync dir（兜底落盘 + FileTool write_backups 共用 / 应然 §A.7） */
  syncDir: string;
  
  /** Tool profile for permission control */
  profile: ToolProfile;
  
  /** phase 1337: capability-tag based group filtering (replaces callerType) */
  allowedGroups: ReadonlySet<ToolGroup>;
  /** phase 1337: opaque audit label (replaces callerType semantic) */
  callerLabel: string;
  
  /** File system instance */
  fs: FileSystem;
  /** Factory for creating FileSystem instances with arbitrary baseDir (cross-claw access) */
  fsFactory?: (baseDir: string) => FileSystem;
  
  /** Optional LLM service */
  llm?: LLMOrchestrator;
  
  /** Maximum allowed steps (ReAct loop limit) */
  maxSteps: number;
  
  /** Optional abort signal */
  signal?: AbortSignal;
  
  
  
  /** Max steps for subagents created via spawn tool */
  subagentMaxSteps?: number;
  
  
  /** 创建链路的源头 clawId，由 summon/spawn 传播 */
  originClawId?: string;
  /** AuditLog writer for tool events */
  auditWriter?: AuditLog;
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
  /** Tool-level wall-clock timeout, inherited from globalConfig.tool_timeout_ms / Assembly 装配期注入 (phase 1029 / F-2) */
  toolTimeoutMs?: number;
  /** phase 1332: injected task scheduler for subagent scheduling (N2 cross-L4 leak fix) */
  taskSystem?: import('./types.js').TaskScheduler;
  /** phase 1343 α-6: turn-level trace id for cross-module audit correlation */
  trace_id?: string;
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
  clawId: ClawId;
  clawDir: ClawDir;
  workspaceDir: string;
  syncDir: string;
  profile: ToolProfile;
  allowedGroups: ReadonlySet<ToolGroup>;
  callerLabel: string;
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  llm?: LLMOrchestrator;
  stepNumber: number;
  maxSteps: number;
  signal?: AbortSignal;
  subagentMaxSteps: number;
  originClawId?: string;
  auditWriter?: AuditLog;
  currentToolUseId?: string;
  fullyReadPaths: Set<string>;
  registry?: ToolRegistry;
  isShadow?: boolean;
  permissionChecker?: PermissionChecker;
  toolTimeoutMs?: number;
  taskSystem?: import('./types.js').TaskScheduler;
  trace_id?: string;
  stopRequested: boolean = false;
  
  private startTime: number;

  constructor(options: ExecContextImplOptions) {
    this.clawId = options.clawId;
    this.clawDir = options.clawDir;
    this.workspaceDir = options.workspaceDir ?? path.join(options.clawDir, CLAWSPACE_DIR);
    this.syncDir = options.syncDir;
    this.profile = options.profile;
    this.allowedGroups = options.allowedGroups;
    this.callerLabel = options.callerLabel;
    this.fs = options.fs;
    this.fsFactory = options.fsFactory;
    this.llm = options.llm;
    this.maxSteps = options.maxSteps;
    this.signal = options.signal;
    this.subagentMaxSteps = options.subagentMaxSteps ?? options.maxSteps;
    this.originClawId = options.originClawId;
    this.auditWriter = options.auditWriter;
    this.currentToolUseId = options.currentToolUseId;
    this.fullyReadPaths = options.fullyReadPaths ?? new Set();
    this.registry = options.registry;
    this.isShadow = options.isShadow;
    this.permissionChecker = options.permissionChecker;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.taskSystem = options.taskSystem;
    this.trace_id = options.trace_id;
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
   * phase 777: called by result-capture tools (done) after storing capturedResult.
   * AgentExecutor reads stopRequested at the top of its loop and exits cleanly, saving the
   * next LLM round-trip.
   */
  requestStop(): void {
    this.stopRequested = true;
    this.auditWriter?.write('stop_requested', `clawId=${this.clawId}`, `step=${this.stepNumber}`);
  }

}
