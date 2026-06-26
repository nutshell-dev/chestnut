/**
 * @module L2c.Tools
 * Tool framework types / phase 501 extracted from executor.ts (C-α 极保守整理性)
 */

import type { JSONSchema7 } from '../llm-provider/types.js';
export type { JSONSchema7 };
import type { ToolProfile } from '../tool-protocol/index.js';
import type { FileSystem } from '../fs/index.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { AuditLog } from '../audit/types.js';
import type { DialogStore } from '../dialog-store/index.js';
import type { ToolDescriptor, ToolResult, CallerSnapshot } from '../tool-protocol/index.js';
export type { CallerSnapshot };

import type { ScheduleAsyncTool } from './async-dispatch.js';
import type { PermissionChecker } from '../tool-protocol/index.js';
import type { ToolUseId } from '../tool-protocol/index.js';
import type { TraceId } from '../audit/types.js';




/**
 * phase 1337 r138 D fork: L2c capability-tag enum.
 * Framework-level capability dimension, decoupled from L3 business CallerType.
 */
export type ToolGroup = string;

/**
 * File overwrite gate state per file path.
 *
 * phase 1430: introduced as `Map<path, FileState>` replacement for flat `fullyReadPaths: Set<string>`.
 * phase 1439: type relocated here from `foundation/file-tool/file-state.ts` (M#5 fix —
 * `tools/` is L2 framework layer, must not reverse-import from `file-tool/` upper layer).
 *
 * Semantic owner: foundation/file-tool/ (writes via read/edit/multi_edit, reads via write).
 * Type lives in tools/ to keep ExecContext self-contained.
 *
 * Cross-target reads MUST NOT write to caller's map (see l2_file_tool.md §7.A.invariant 2).
 */
export interface FileState {
  /** SHA-256 hex digest of content seen by the agent. */
  hash: string;
  /** File mtime (ms epoch) at the time of the read. */
  timestamp: number;
  /**
   * True iff the read covered every current line of the file:
   * (a) visible range started at line 1 (offset undefined OR offset === 1)
   * (b) visible range covered through the last line (end >= totalLines after slicing)
   * (c) output not byte-cap truncated (≤ READ_OUTPUT_HARD_CAP_BYTES)
   * (d) same-target read (no cross-target param)
   *
   * phase 1444 reframe: was "(a) offset/limit both undefined (b) no line cap";
   * now `limit >= totalLines` explicit reads also count, removing the 200-line
   * cliff that effectively banned overwrite of larger files.
   */
  isFullRead: boolean;
}


// ── Tool & ExecContext ─────────────────────────────────────────────
// Owned by L2c Tools (execution framework). Moved from L2b ToolProtocol
// (phase boundary refactoring 2026-05) where they violated M#5 — L2b
// knowing about L4 business semantics via ExecContext fields.
//
// ToolProtocol (L2b) now owns only ToolDescriptor — the pure LLM-facing
// protocol skeleton (name, description, input_schema).

/**
 * phase 1459 P3 α-1: ExecContext 28 字段 + 4 方法 按维度拆 5 子接口。
 * ExecContext 仍是 union（extends 5 子接口）、50 import site 0 改 / 0 caller cascade。
 * 新工具可声明只依赖子接口（M#8 接口最小化 / ISP 软合规）。
 * 详 `coding plan/phase1455/Step B — design ExecContext ISP.md` §2.1 字段→子接口完整 mapping。
 */

/** 身份维度（D1）：clawId / clawDir / chestnutRoot / workspaceDir / syncDir */
export interface ClawIdentity {
  clawId: string;
  clawDir: string;
  /** phase 509 NEW / 装配期 per-callerType resolve / 主代理=clawDir/clawspace / 子代理=clawDir/tasks/subagents/<task-id> (phase 512 落地) */
  workspaceDir: string;
  /** 装配-level 共享 sync dir（兜底落盘 + FileTool write_backups 共用 / 应然 §A.7）/ Assembly 装配期注入 */
  syncDir: string;
}

/** 权限维度（D2）：profile / allowedGroups / callerLabel / permissionChecker */
export interface ToolPermissions {
  profile: ToolProfile;
  /** phase 1337: capability-tag based group filtering (replaces callerType) */
  allowedGroups: ReadonlySet<ToolGroup>;
  /**
   * phase 1337: opaque caller identifier.
   * L2 carrier、L4 caller 写值（'shadow' / 'claw' / motion clawId / ...）、L4 reader 业务读双用：
   * (a) audit annotation（executor.ts:90 / async-dispatch.ts）
   * (b) origin guard（notify-claw.ts MOTION_CLAW_ID gate per phase 1459 α-5；spawn/summon/shadow SHADOW_CALLER_LABEL guard per phase 61）
   * L2 不解释具体 value 语义。
   */
  callerLabel: string;
  /** Assembly-injected per-claw permission checker (replaces module-level factory pattern, phase 1006) */
  permissionChecker?: PermissionChecker;
}

/** 基础设施维度（D3）：fs / fsFactory / llm / registry */
export interface ExecutionInfra {
  fs: FileSystem;
  fsFactory?: (baseDir: string) => FileSystem;
  llm?: LLMOrchestrator;
  /** Tool registry reference for sync spawn path (phase 766) */
  registry?: ToolRegistry;
  /** phase 27: main dialog store injection (was as { mainDialogStore } cast, phase 768) */
  mainDialogStore?: DialogStore;
}

/** 执行控制维度（D4）：maxSteps / signal / subagentMaxSteps / toolTimeoutMs / stopRequested + requestStop / getElapsedMs */
export interface ExecutionControl {
  maxSteps: number;
  signal?: AbortSignal;
  /** Max steps for subagents created via spawn tool */
  subagentMaxSteps?: number;
  /** Tool-level wall-clock timeout, inherited from globalConfig.tool_timeout_ms / Assembly 装配期注入 (phase 1029 / F-2) */
  toolTimeoutMs?: number;
  /** phase 777: result-capture tools (done) set this to break the agent loop early */
  stopRequested: boolean;
  /** phase 777: mutator called by result-capture tools after storing capturedResult */
  requestStop(): void;
  getElapsedMs(): number;
}

/** 审计 + 状态维度（D5）：auditWriter / currentToolUseId / trace_id / readFileState / persistReadFileState / getCallerSnapshot */
export interface ExecutionAudit {
  /** AuditLog writer for tool events */
  auditWriter?: AuditLog;
  /** Current tool_use block id (set by ToolExecutor before tool.execute) */
  currentToolUseId?: ToolUseId;
  /** phase 1343 α-6: turn-level trace id for cross-module audit correlation */
  trace_id?: TraceId;
  /**
   * Per-claw read state for overwrite gate (phase 1430、formerly `fullyReadPaths: Set<string>`).
   * Map<resolvedPath, FileState{hash, timestamp, isFullRead}>.
   * Cross-claw reads MUST NOT write to caller's map (per §7.A.invariant 2).
   *
   * Lifecycle (phase 1443): persisted to `<clawDir>/read-state.json` when `persistReadFileState=true`;
   * loaded by Runtime.initialize(); cleared by regime-switch hook. Without `persistReadFileState`
   * (subagent contexts), the Map only lives for the duration of the context.
   */
  readFileState: Map<string, FileState>;
  /**
   * If true, FileStateManager helpers persist readFileState mutations to `<clawDir>/read-state.json`
   * and regime-switch deletes the file. Runtime sets this to true for the main claw context.
   * Subagent contexts leave it undefined → skip persistence (state lives only in memory).
   */
  persistReadFileState?: boolean;
  /**
   * phase 1406: lazy caller deep context snapshot.
   * Returns caller's systemPrompt + tools + messages on demand.
   * Bound by Claw/Assembly at construction time (typically reads
   * DialogStore/ToolRegistry/Prompt module). Lazy — not materialized until called.
   *
   * Access gate: only tools declaring `accessesCaller: true` are allowed to
   * invoke this method; ToolExecutor wraps with a throwing variant otherwise
   * and emits `TOOL_CALLER_ACCESS_VIOLATION` audit.
   *
   * Optional because: not all ExecContexts need it (subagents may have null
   * caller-snapshot semantics). Tools that declare accessesCaller=true and
   * receive a ctx without this field will see the executor guard reject.
   */
  getCallerSnapshot?(): Promise<CallerSnapshot>;
  /**
   * subagent task id (set by subagent ctx builder at assembly time).
   * 通用执行身份标识、不携带任何业务语义。
   * exec / spawn 等工具可借此注入子进程 env 实现跨进程身份传递。
   * Motion 主代理 ctx 不设此字段。
   */
  subagentTaskId?: string;
}

/**
 * Execution context for tool invocations.
 *
 * phase 1459 α-1: ExecContext = ClawIdentity & ToolPermissions & ExecutionInfra & ExecutionControl & ExecutionAudit.
 * phase 61：isShadow 已迁、由 callerLabel === SHADOW_CALLER_LABEL 替代（per phase 1337 callerType 治理同型 pattern、phase 1459 α-5 callerLabel 业务读 ratify）。L2 无 L4 business field 漏抽象。
 * 50 import site 0 改动 / 0 caller cascade。新工具可声明只依赖子接口（M#8 接口最小化）。
 */
export interface ExecContext extends
  ClawIdentity,
  ToolPermissions,
  ExecutionInfra,
  ExecutionControl,
  ExecutionAudit
{}

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
  /** phase 1337: capability group this tool belongs to (replaces profile-based implicit filtering) */
  group: ToolGroup;
  /**
   * phase 1406: declares whether this tool reads caller deep context via
   * `ctx.getCallerSnapshot()`.
   *
   * Defaults to false. Tools that need caller systemPrompt + tools + messages
   * (e.g., SummonTool for shadow inheritance) must opt-in by setting true.
   * ToolExecutor enforces: tools without accessesCaller=true calling
   * `getCallerSnapshot()` throw + emit `TOOL_CALLER_ACCESS_VIOLATION` audit.
   *
   * M#8 minimal interface守: caller deep context is a stronger capability
   * (read caller's dialog history + system prompt) — explicit declaration
   * enables mechanical audit + future lint.
   */
  readonly accessesCaller?: boolean;
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
  toolUseId?: ToolUseId;   // 新增：LLM 生成的 tool_use block id
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
  getToolSchema?(name: string): JSONSchema7 | undefined;
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
