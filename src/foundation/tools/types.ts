/**
 * @module L2.Tools
 * Tool framework types / phase 501 extracted from executor.ts (C-α 极保守整理性)
 */

import type { JSONSchema7 } from '../../types/message.js';
import type { ToolProfile } from '../../types/config.js';
import type { FileSystem } from '../fs/types.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { AuditLog } from '../audit/index.js';
import type { Tool, ToolResult, ExecContext } from '../tool-protocol/index.js';
import type { ScheduleAsyncTool } from './async-dispatch.js';
import type { DialogStore } from '../dialog-store/index.js';

/** Escape multi-line content for audit TSV log (used by ToolExecutorImpl) */
export function escapeForLog(s: string): string {
  return s.replace(/\n/g, '\\n').slice(0, 120);
}

/**
 * Tool registry interface
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
  callerClawId?: string;        // phase 514 / subagent caller's clawId
  fs: FileSystem;
  llm?: LLMOrchestrator;
  subagentMaxSteps?: number;
  auditWriter?: AuditLog;
  scheduleAsyncTool?: ScheduleAsyncTool;
  mainDialogStore?: DialogStore;
  mainContextSnapshot?: { clawId: string; toolUseId: string };
  /** Tool-level default timeout (phase 1029 / F-2 / inherits from caller ExecContext / 0 传维持 ToolExecutor fallback 60s) */
  defaultTimeoutMs?: number;
}
