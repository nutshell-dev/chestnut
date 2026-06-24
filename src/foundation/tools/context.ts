/**
 * ExecContextImpl - Execution context implementation
 * 
 * Provides context for tool execution including:
 * - Identity (clawId, clawDir)
 * - Permissions based on tool profile
 * - Dependencies (fs, llm)
 * - Execution tracking (elapsed time)
 */

import type { FileSystem } from '../fs/index.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { ToolProfile } from '../tool-protocol/index.js';
import type { ExecContext, ToolGroup, FileState } from './types.js';
import type { TraceId } from '../audit/types.js';
import type { ToolUseId } from '../tool-protocol/index.js';

import path from 'path';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';


import type { AuditLog } from '../audit/types.js';
import type { DialogStore } from '../dialog-store/index.js';

import type { ToolRegistry } from './types.js';
import type { PermissionChecker } from '../tool-protocol/index.js';
import { TOOL_AUDIT_EVENTS } from './audit-events.js';

/**
 * Options for creating execution context
 */
export interface ExecContextImplOptions {
  /** Claw identifier */
  clawId: string;

  /** Claw workspace directory */
  clawDir: string;

  /**
   * phase 531: caller-pre-computed motion-chain status.
   * foundation no longer holds motion concept; caller computes
   * `clawId === MOTION_CLAW_ID || originClawId === MOTION_CLAW_ID` and passes the boolean.
   * Optional: defaults to false; production callers (runtime / subagent) must compute and pass.
   */
  isMotionChain?: boolean;

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
  currentToolUseId?: ToolUseId;
  /**
   * Per-claw read state for overwrite gate (phase 1430).
   * See ExecContext.readFileState for semantics.
   */
  readFileState?: Map<string, FileState>;
  /** phase 1443: opt-in flag for atomic-persistence + regime-switch clearing (default false = subagent). */
  persistReadFileState?: boolean;
  /** Tool registry reference for sync spawn path (phase 766) */
  registry?: ToolRegistry;
  /** phase 27: main dialog store injection (was as { mainDialogStore } cast, phase 768) */
  mainDialogStore?: DialogStore;
  /** Assembly-injected per-claw permission checker (replaces module-level factory pattern, phase 1006) */
  permissionChecker?: PermissionChecker;
  /** Tool-level wall-clock timeout, inherited from globalConfig.tool_timeout_ms / Assembly 装配期注入 (phase 1029 / F-2) */
  toolTimeoutMs?: number;
  /** phase 1332: injected task scheduler for subagent scheduling (N2 cross-L4 leak fix) */
  taskSystem?: import('./types.js').TaskScheduler;
  /** phase 1343 α-6: turn-level trace id for cross-module audit correlation */
  trace_id?: TraceId;
  /**
   * phase 1406: lazy caller deep context provider (systemPrompt + tools + messages).
   * Bound by Claw/Assembly at construction. Only tools declaring
   * `accessesCaller: true` are allowed to invoke; ToolExecutor wraps otherwise.
   */
  getCallerSnapshot?: import('./types.js').ExecContext['getCallerSnapshot'];
  /**
   * subagent task id (set by subagent ctx builder at assembly time).
   * 通用执行身份标识、不携带任何业务语义。
   */
  subagentTaskId?: string;
}

/**
 * Clone an ExecContext while preserving prototype chain.
 *
 * Object spread `{ ...ctx, ... }` only copies own enumerable properties,
 * losing class methods/getters from ExecContextImpl (`isMotionChain`,
 * `getElapsedMs`). This helper preserves them.
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
  /** phase 531: caller-pre-computed motion-chain status (foundation 0 motion concept) */
  isMotionChain: boolean;
  workspaceDir: string;
  syncDir: string;
  profile: ToolProfile;
  allowedGroups: ReadonlySet<ToolGroup>;
  callerLabel: string;
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  llm?: LLMOrchestrator;
  maxSteps: number;
  signal?: AbortSignal;
  subagentMaxSteps: number;
  originClawId?: string;
  auditWriter?: AuditLog;
  currentToolUseId?: ToolUseId;
  readFileState: Map<string, FileState>;
  persistReadFileState?: boolean;
  registry?: ToolRegistry;
  mainDialogStore?: DialogStore;
  permissionChecker?: PermissionChecker;
  toolTimeoutMs?: number;
  taskSystem?: import('./types.js').TaskScheduler;
  trace_id?: TraceId;
  getCallerSnapshot?: import('./types.js').ExecContext['getCallerSnapshot'];
  subagentTaskId?: string;
  stopRequested: boolean = false;
  
  private startTime: number;

  constructor(options: ExecContextImplOptions) {
    this.clawId = options.clawId;
    this.clawDir = options.clawDir;
    this.isMotionChain = options.isMotionChain ?? false;
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
    this.readFileState = options.readFileState ?? new Map();
    this.persistReadFileState = options.persistReadFileState;
    this.registry = options.registry;
    this.mainDialogStore = options.mainDialogStore;
    this.permissionChecker = options.permissionChecker;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.taskSystem = options.taskSystem;
    this.trace_id = options.trace_id;
    this.getCallerSnapshot = options.getCallerSnapshot;
    this.subagentTaskId = options.subagentTaskId;
    this.startTime = Date.now();
  }

  /**

   * Get elapsed time since context creation
   */
  getElapsedMs(): number {
    return Date.now() - this.startTime;
  }

  /**
   * phase 777: called by result-capture tools (done) after storing capturedResult.
   * AgentExecutor reads stopRequested at the top of its loop and exits cleanly, saving the
   * next LLM round-trip.
   */
  requestStop(): void {
    this.stopRequested = true;
    this.auditWriter?.write(TOOL_AUDIT_EVENTS.STOP_REQUESTED, `clawId=${this.clawId}`, `step_count=-`);
  }

}
