/**
 * @module L2.Tools
 * Tool framework types / phase 501 extracted from executor.ts (C-α 极保守整理性)
 */

import type { JSONSchema7 } from '../llm-provider/types.js';
import type { ToolProfile } from '../tool-protocol/index.js';
import type { FileSystem } from '../fs/types.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { AuditLog } from '../audit/index.js';
import type { ToolDescriptor, ToolResult } from '../tool-protocol/index.js';
import type { ScheduleAsyncTool } from './async-dispatch.js';
import type { CallerType } from '../../core/caller-types.js';
import type { PermissionChecker } from '../tool-protocol/permission.js';

/**
 * Escape multi-line content for audit TSV log (used by ToolExecutorImpl).
 * Truncated to 120 chars to prevent audit log bloat; full content is
 * preserved in the actual tool result.
 */
export function escapeForLog(s: string): string {
  return s.replace(/\n/g, '\\n').slice(0, 120);
}

// ── Tool & ExecContext ─────────────────────────────────────────────
// Owned by L2c Tools (execution framework). Moved from L2b ToolProtocol
// (phase boundary refactoring 2026-05) where they violated M#5 — L2b
// knowing about L4 business semantics via ExecContext fields.
//
// ToolProtocol (L2b) now owns only ToolDescriptor — the pure LLM-facing
// protocol skeleton (name, description, input_schema).

/**
 * Execution context — passed to all tool executions.
 *
 * Fields are L1/L2 infrastructure handles + execution control state.
 * L4 business fields (isShadow) are scheduled
 * for eviction to per-module factory injection.
 */
export interface ExecContext {
  clawId: string;
  clawDir: string;
  /** phase 509 NEW / 装配期 per-callerType resolve / 主代理=clawDir/clawspace / 子代理=clawDir/tasks/subagents/<task-id> (phase 512 落地) */
  workspaceDir: string;
  /** 装配-level 共享 sync dir（兜底落盘 + FileTool write_backups 共用 / 应然 §A.7）/ Assembly 装配期注入 */
  syncDir: string;
  /** Caller type for spawn recursion prevention */
  callerType: CallerType;
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  llm?: LLMOrchestrator;
  profile: ToolProfile;
  stepNumber: number;
  maxSteps: number;
  signal?: AbortSignal;
  /** Max steps for subagents created via spawn tool */
  subagentMaxSteps?: number;
  /** Tool-level wall-clock timeout, inherited from globalConfig.tool_timeout_ms / Assembly 装配期注入 (phase 1029 / F-2) */
  toolTimeoutMs?: number;
  /** 创建链路的源头 clawId，由 summon/spawn 传播。Motion 直接创建时为 'motion' */
  originClawId?: string;
  /** 是否为 Motion 创建链路上的 agent（Motion 本体或其 subagent） */
  readonly isMotionChain: boolean;
  getElapsedMs(): number;
  incrementStep(): void;
  /** AuditLog writer for tool events */
  auditWriter?: AuditLog;
  /** Current tool_use block id (set by ToolExecutor before tool.execute) */
  currentToolUseId?: string;
  /** Session-scoped fully-read paths（read 未截断时 add / overwrite gate / phase 487 G6） */
  fullyReadPaths: Set<string>;
  /** Tool registry reference for sync spawn path (phase 766) */
  registry?: ToolRegistry;
  /** Whether this context belongs to a shadow agent (phase 766 prep for 767) */
  isShadow?: boolean;
  /** phase 777: result-capture tools (done) set this to break the agent loop early */
  stopRequested: boolean;
  /** phase 777: mutator called by result-capture tools after storing capturedResult */
  requestStop(): void;
  /** Assembly-injected per-claw permission checker (replaces module-level factory pattern, phase 1006) */
  permissionChecker?: PermissionChecker;
}

/**
 * Tool interface — all tools implement this.
 *
 * Extends the pure LLM-facing ToolDescriptor (L2b) with execution-framework
 * metadata (readonly, idempotent, timeout) and the execute method.
 * Owned by L2c Tools.
 */
export interface Tool extends ToolDescriptor {
  readonly: boolean;
  idempotent: boolean;
  supportsAsync?: boolean;
  defaultTimeoutMs?: number;
  /** Which profiles this tool belongs to. Each tool declares its own (M#3). */
  profiles: readonly ToolProfile[];
  execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult>;
}

/**
 * Tool registry interface.
 * Owned by L2c Tools — defined here alongside Tool for clean dependency direction.
 */
export interface ToolRegistry {
  register(tool: Tool): void;
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  getAll(): Tool[];
  getForProfile(profile: ToolProfile): Tool[];
  formatForLLM(tools: Tool[]): Array<{
    name: string;
    description: string;
    input_schema: JSONSchema7;
  }>;
}

/**
 * Tool execution options
 */
export interface ExecuteOptions {
  toolName: string;
  args: Record<string, unknown>;
  ctx: ExecContext;
  timeoutMs?: number;
  async?: boolean;   // 新增：true 时走异步路径
  toolUseId?: string;   // 新增：LLM 生成的 tool_use block id
}

/**
 * Tool executor interface
 */
export interface IToolExecutor {
  execute(options: ExecuteOptions): Promise<ToolResult>;
  executeParallel(
    batch: Array<{ toolName: string; args: Record<string, unknown> }>,
    ctx: ExecContext
  ): Promise<(ToolResult | null)[]>;
  validateArgs(toolName: string, args: Record<string, unknown>): { valid: boolean; errors?: string[] };
}

/**
 * Extended ToolExecutor options
 */
export interface ToolExecutorOptions {
  registry: ToolRegistry;
  clawDir: string;
  syncDir: string;
  workspaceDir?: string;
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  llm?: LLMOrchestrator;
  subagentMaxSteps?: number;
  auditWriter?: AuditLog;
  scheduleAsyncTool?: ScheduleAsyncTool;
  /** Tool-level default timeout (phase 1029 / F-2 / inherits from caller ExecContext / 0 传维持 ToolExecutor fallback 60s) */
  defaultTimeoutMs?: number;
}
