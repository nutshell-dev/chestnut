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
import type { Message } from '../../types/message.js';
import type { CallerType } from './caller-type.js';
import type { AuditLog } from '../audit/index.js';
import type { DialogStore } from '../dialog-store/index.js';

export type { JSONSchema7, ToolProfile, CallerType };

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
  execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult>;
}
