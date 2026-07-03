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
import type { ToolDescriptor, ToolResult, CallerSnapshot } from '../tool-protocol/index.js';
export type { CallerSnapshot };

import type { PermissionChecker } from '../tool-protocol/index.js';
import type { ToolUseId } from '../tool-protocol/index.js';
import type { TraceId } from '../audit/types.js';




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

/** 权限维度（D2）：profile / permissionChecker */
export interface ToolPermissions {
  profile: ToolProfile;
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
  /**
   * Phase 773: base registry containing the plain sync exec Tool.
   * Used by spawn/shadow subagent creation paths so subagents do not
   * inherit the main-agent async wrapper exec.
   */
  baseRegistry?: ToolRegistry;
}

/** 执行控制维度（D4）：signal / toolTimeoutMs / stopRequested + requestStop / getElapsedMs */
export interface ExecutionControl {
  signal?: AbortSignal;
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
 * L2 无 L4 business caller 身份字段。Phase 807 删除 callerLabel，L4 通过工具多实例 DI 实现调用限制。
 * 新工具可声明只依赖子接口（M#8 接口最小化）。
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
  defaultTimeoutMs?: number;
  /** Which profiles this tool belongs to. Each tool declares its own (M#3). */
  profiles: readonly ToolProfile[];
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
  auditWriter?: AuditLog;
  /** Tool-level default timeout (phase 1029 / F-2 / inherits from caller ExecContext / 0 传维持 ToolExecutor fallback 60s) */
  defaultTimeoutMs?: number;
  /**
   * Phase 773: base registry containing the plain sync exec Tool.
   * Passed through to constructed ExecContext instances for subagent spawn paths.
   */
  baseRegistry?: ToolRegistry;
}
