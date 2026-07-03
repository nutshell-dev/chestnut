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
import type { ExecContext, FileState } from './types.js';
import type { TraceId } from '../audit/types.js';
import type { ToolUseId } from '../tool-protocol/index.js';

import path from 'path';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';


import type { AuditLog } from '../audit/types.js';

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

  /** phase 509 / 可选 / 默认 fallback = path.join(clawDir, CLAWSPACE_DIR) */
  workspaceDir?: string;

  /** 装配-level 共享 sync dir（兜底落盘 + FileTool write_backups 共用 / 应然 §A.7） */
  syncDir: string;
  
  /** Tool profile for permission control */
  profile: ToolProfile;
  
  /** phase 1337: opaque audit label (replaces callerType semantic) */
  callerLabel: string;
  
  /** File system instance */
  fs: FileSystem;
  /** Factory for creating FileSystem instances with arbitrary baseDir (cross-claw access) */
  fsFactory?: (baseDir: string) => FileSystem;
  
  /** Optional LLM service */
  llm?: LLMOrchestrator;
  
  /** Optional abort signal */
  signal?: AbortSignal;
  
  
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
  /**
   * Phase 773: base registry containing the plain sync exec Tool.
   * Used by spawn/shadow subagent creation paths so subagents do not
   * inherit the main-agent async wrapper exec.
   */
  baseRegistry?: ToolRegistry;
  /** Assembly-injected per-claw permission checker (replaces module-level factory pattern, phase 1006) */
  permissionChecker?: PermissionChecker;
  /** Tool-level wall-clock timeout, inherited from globalConfig.tool_timeout_ms / Assembly 装配期注入 (phase 1029 / F-2) */
  toolTimeoutMs?: number;
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
 * losing class methods/getters from ExecContextImpl (`getElapsedMs`).
 * This helper preserves them.
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
  syncDir: string;
  profile: ToolProfile;
  callerLabel: string;
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  llm?: LLMOrchestrator;
  signal?: AbortSignal;
  auditWriter?: AuditLog;
  currentToolUseId?: ToolUseId;
  readFileState: Map<string, FileState>;
  persistReadFileState?: boolean;
  registry?: ToolRegistry;
  baseRegistry?: ToolRegistry;
  permissionChecker?: PermissionChecker;
  toolTimeoutMs?: number;
  trace_id?: TraceId;
  getCallerSnapshot?: import('./types.js').ExecContext['getCallerSnapshot'];
  subagentTaskId?: string;
  stopRequested: boolean = false;
  
  private startTime: number;

  constructor(options: ExecContextImplOptions) {
    this.clawId = options.clawId;
    this.clawDir = options.clawDir;
    this.workspaceDir = options.workspaceDir ?? path.join(options.clawDir, CLAWSPACE_DIR);
    this.syncDir = options.syncDir;
    this.profile = options.profile;
    this.callerLabel = options.callerLabel;
    this.fs = options.fs;
    this.fsFactory = options.fsFactory;
    this.llm = options.llm;
    this.signal = options.signal;
    this.auditWriter = options.auditWriter;
    this.currentToolUseId = options.currentToolUseId;
    this.readFileState = options.readFileState ?? new Map();
    this.persistReadFileState = options.persistReadFileState;
    this.registry = options.registry;
    this.baseRegistry = options.baseRegistry;
    this.permissionChecker = options.permissionChecker;
    this.toolTimeoutMs = options.toolTimeoutMs;
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
