/**
 * @module L2.ToolProtocol
 * ToolProtocol module (L2) — LLM tool calling 协议 schema 单源
 *
 * arch §12: 「LLM 工具调用协议的 schema 抽象 / L2 LLM 语义基础设施 / 对接 LLM messages 中 tool_use/tool_result 协议 / 不知 clawforum 业务 / 是纯 LLM 协议层抽象」
 *
 * type-only / 无 runtime / 无 audit events
 */

import type { JSONSchema7 } from '../../types/message.js';
import type { ToolProfile } from '../../types/config.js';
import type { FileSystem } from '../fs/types.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { Message, ToolDefinition } from '../../types/message.js';
import type { CallerType } from './caller-type.js';
import type { AuditLog } from '../audit/index.js';
import type { DialogStore } from '../dialog-store/index.js';
import type { ToolRegistry } from '../tools/types.js';
import type { PermissionChecker } from '../../types/permission.js';

export type { JSONSchema7, ToolProfile, CallerType };
export { callerTypeToProfile } from './caller-type.js';

/**
 * Tool execution result
 */
export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: {
    filesAffected?: string[];
    durationMs?: number;
    [key: string]: unknown;
  };
}

/**
 * Execution context - Passed to all tool executions
 */
export interface ExecContext {
  clawId: string;
  clawDir: string;
  /** phase 509 NEW / 装配期 per-callerType resolve / 主代理=clawDir/clawspace / 子代理=clawDir/tasks/subagents/<task-id> (phase 512 落地) */
  workspaceDir: string;
  /** phase 514 / subagent caller's clawId / undefined for main claw / 装配方 per-callerType resolve */
  callerClawId?: string;
  /** 装配-level 共享 sync dir（兜底落盘 + FileTool write_backups 共用 / 应然 §A.7）/ Assembly 装配期注入 */
  syncDir: string;
  contractId?: string;
  /** Caller type for spawn recursion prevention */
  callerType: CallerType;
  fs: FileSystem;
  llm?: LLMOrchestrator;
  profile: ToolProfile;
  stepNumber: number;
  maxSteps: number;
  signal?: AbortSignal;
  /** Max steps for subagents created via spawn tool */
  subagentMaxSteps?: number;
  /** Tool-level wall-clock timeout, inherited from globalConfig.tool_timeout_ms / Assembly 装配期注入 (phase 1029 / F-2) */
  toolTimeoutMs?: number;
  /** 当前对话 messages（由 runtime._runReact 注入，供 dispatch 工具读取） */
  dialogMessages?: Message[];
  /** 创建链路的源头 clawId，由 dispatch/spawn 传播。Motion 直接创建时为 'motion' */
  originClawId?: string;
  /** 是否为 Motion 创建链路上的 agent（Motion 本体或其 subagent） */
  readonly isMotionChain: boolean;
  getElapsedMs(): number;
  incrementStep(): void;
  /** AuditLog writer for tool events */
  auditWriter?: AuditLog;
  /** Main dialog store (subagent profile only / ask_caller read-only ref) */
  mainDialogStore?: DialogStore;
  /** Marker for restoring main context prefix via DialogStore.restorePrefix */
  mainContextSnapshot?: { clawId: string; toolUseId: string };
  /** Current tool_use block id (set by ToolExecutor before tool.execute) */
  currentToolUseId?: string;
  /** Session-scoped fully-read paths（read 未截断时 add / overwrite gate / phase 487 G6） */
  fullyReadPaths: Set<string>;
  /** Tool registry reference for sync spawn path (phase 766) */
  registry?: ToolRegistry;
  /** Whether this context belongs to a shadow agent (phase 766 prep for 767) */
  isShadow?: boolean;
  /** Current main agent turn's systemPrompt (in-memory, set by runtime before runReact) — phase 769 */
  systemPromptForLLM?: string;
  /** Current main agent turn's tools array (in-memory, set by runtime before runReact) — phase 769 */
  toolsForLLM?: ToolDefinition[];
  /** phase 777: result-capture tools (done, report_result) set this to break the agent loop early */
  stopRequested: boolean;
  /** phase 777: mutator called by result-capture tools after storing capturedResult */
  requestStop(): void;
  /** Assembly-injected per-claw permission checker (replaces module-level factory pattern, phase 1006) */
  permissionChecker?: PermissionChecker;
}

/**
 * Tool interface - All tools implement this
 */
export interface Tool {
  name: string;
  description: string;
  schema: JSONSchema7;
  readonly: boolean;
  idempotent: boolean;        // 多次调用结果相同（只读工具均为 true）
  supportsAsync?: boolean;    // 是否支持异步调用（默认 false）
  defaultTimeoutMs?: number;  // 工具级默认超时（覆盖 executor 默认值）
  execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult>;
}
