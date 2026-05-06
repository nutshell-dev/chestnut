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
import { MOTION_CLAW_ID, DEFAULT_MAX_STEPS } from '../../constants.js';


import type { Message } from '../../types/message.js';
import type { AuditLog } from '../audit/index.js';
import type { CallerType } from '../tool-protocol/caller-type.js';
import type { DialogStore } from '../dialog-store/index.js';

/**
 * Options for creating execution context
 */
export interface ExecContextImplOptions {
  /** Claw identifier */
  clawId: string;
  
  /** Claw workspace directory */
  clawDir: string;
  
  /** phase 509 / 可选 / 默认 fallback = path.join(clawDir, 'clawspace') */
  workspaceDir?: string;
  
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
  maxSteps?: number;
  
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
  
  private startTime: number;

  constructor(options: ExecContextImplOptions) {
    this.clawId = options.clawId;
    this.clawDir = options.clawDir;
    this.workspaceDir = options.workspaceDir ?? path.join(options.clawDir, 'clawspace');
    this.syncDir = options.syncDir;
    this.profile = options.profile;
    this.callerType = options.callerType ?? 'claw';
    this.fs = options.fs;
    this.llm = options.llm;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.signal = options.signal;
    this.subagentMaxSteps = options.subagentMaxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.dialogMessages = options.dialogMessages;
    this.originClawId = options.originClawId;
    this.auditWriter = options.auditWriter;
    this.mainDialogStore = options.mainDialogStore;
    this.mainContextSnapshot = options.mainContextSnapshot;
    this.currentToolUseId = options.currentToolUseId;
    this.fullyReadPaths = options.fullyReadPaths ?? new Set();
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

}
