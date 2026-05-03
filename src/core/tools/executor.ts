/**
 * Tool Executor - Execution context and tool interfaces
 * Phase 0: Interface definitions + Implementation
 * 
 * This file contains both:
 * - Interface definitions (from Phase 0)
 * - ToolExecutorImpl implementation (Phase 1)
 */

import type { JSONSchema7 } from '../../types/message.js';
import type { ToolProfile } from '../../types/config.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { TaskScheduler } from './task-scheduler.js';
import type { OutboxWriter } from '../../foundation/messaging/index.js';
import type { Message } from '../../types/message.js';
import type { CallerType } from './caller-type.js';
import type { Audit } from '../../foundation/audit/index.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  ToolNotFoundError,
  ToolTimeoutError,
  ToolInvalidInputError,
} from '../../types/errors.js';
import { ExecContextImpl, cloneExecContext } from './context.js';
import { DEFAULT_MAX_STEPS } from '../../constants.js';
import type { ToolRegistryImpl } from './registry.js';
// Note: ToolRegistry type imported via ToolRegistry interface

function escapeForLog(s: string): string {
  return s.replace(/\n/g, '\\n').slice(0, 120);
}

// ============================================================================
// Phase 0: Interface Definitions (Frozen)
// ============================================================================

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
  /** Audit writer for tool events */
  auditWriter?: Audit;
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
  ): Promise<ToolResult[]>;
  validateArgs(toolName: string, args: Record<string, unknown>): { valid: boolean; errors?: string[] };
}

// ============================================================================
// Phase 1: Implementation
// ============================================================================

/**
 * Tool execution implementation
 */
export class ToolExecutorImpl implements IToolExecutor {
  protected taskSystem?: TaskScheduler;

  constructor(
    private registry: ToolRegistry,
    private defaultTimeoutMs = 60000
  ) {}

  /**
   * Execute a single tool
   */
  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const { toolName, args, ctx, timeoutMs = this.defaultTimeoutMs } = options;
    const startTime = Date.now();

    // 1. Find tool
    const tool = this.registry.get(toolName);
    if (!tool) {
      throw new ToolNotFoundError(toolName);
    }

    // 2. Schema validation (simple check)
    const validation = this.validateArgs(toolName, args);
    if (!validation.valid) {
      throw new ToolInvalidInputError(toolName, validation.errors?.[0] ?? 'Invalid input');
    }

    // Async path: tool lifecycle owned by TaskSystem, no signal merge here.
    // 4. Async path: submit to TaskSystem, return immediately
    if (options.async) {
      if (ctx.callerType !== 'claw') {
        return { success: false, content: 'Async mode is not available for subagents.' };
      }
      const taskSystem = this.taskSystem;
      if (!taskSystem) {
        return { success: false, content: 'Async mode requires TaskSystem (not available).' };
      }
      if (!tool.supportsAsync) {
        return { success: false, content: `Tool "${toolName}" does not support async mode.` };
      }
      const executeCallback = () => tool.execute(args, ctx);
      const taskId = await taskSystem.scheduleTool(
        toolName,
        executeCallback,
        ctx.clawId,
        { isIdempotent: tool.idempotent, callerType: ctx.callerType === 'claw' ? undefined : ctx.callerType, toolUseId: options.toolUseId }
      );
      ctx.auditWriter?.write(
        'tool_async_start',
        toolName,
        options.toolUseId ?? '',
        `task=${taskId}`,
      );
      return {
        success: true,
        content: `Async task queued. Task ID: ${taskId}. Result will be delivered to inbox when complete.`,
        metadata: { taskId, async: true },
      };
    }

    // 5. Execute with timeout using Promise.race (sync path)
    // Timeout + signal merging: executor 的 timeout abort 与 options.signal 合并，
    // 传给 tool ctx.signal，让支持 signal 的工具在超时时主动退出。
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

    const upstreamSignals = ctx.signal ? [ctx.signal] : [];
    const mergedSignal = upstreamSignals.length === 0
      ? timeoutController.signal
      : AbortSignal.any([...upstreamSignals, timeoutController.signal]);

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutController.signal.addEventListener(
        'abort',
        () => reject(new ToolTimeoutError(toolName, timeoutMs)),
        { once: true },
      );
    });
    timeoutPromise.catch(() => {});  // race 胜出后的孤立 rejection fallback

    // 用 mergedSignal 覆盖 ctx.signal（保留 prototype chain）
    const ctxWithSignal = cloneExecContext(ctx, { signal: mergedSignal });
    const executionPromise = tool.execute(args, ctxWithSignal);
    executionPromise.catch(() => {});  // 对不响应 signal 的 tool 保底

    let result: ToolResult | undefined;
    try {
      result = await Promise.race([executionPromise, timeoutPromise]);
    } catch (err) {
      // Execution failed - create error result for LLM
      result = {
        success: false,
        content: err instanceof Error ? err.message : String(err),
      };
      // finally 块完成 audit logging 后走 return result!
    } finally {
      // Clean up timeout timer
      clearTimeout(timeoutId);
      
      // Audit logging via auditWriter (TSV format)
      const duration = Date.now() - startTime;
      const auditResult = result ?? { success: false, content: 'unknown' };
      ctx.auditWriter?.write(
        'tool_exec',
        toolName,
        auditResult.success ? 'ok' : 'err',
        `ms=${duration}`,
        `summary=${escapeForLog(auditResult.content ?? '')}`,
      );
    }
    
    return result!;
  }

  /**
   * Execute multiple read-only tools in parallel
   * Write operations are executed sequentially (not in this batch)
   * 
   * NOTE: 当前 ReAct 循环每步单工具调用，写操作天然串行。
   * executeParallel 已过滤为只读工具，无需额外串行化。
   */
  async executeParallel(
    batch: Array<{ toolName: string; args: Record<string, unknown> }>,
    ctx: ExecContext
  ): Promise<ToolResult[]> {
    // Filter to only read-only tools
    const readOnlyCalls = batch.filter(({ toolName }) => {
      const tool = this.registry.get(toolName);
      return tool?.readonly === true;
    });

    // Execute all in parallel
    const promises = readOnlyCalls.map(({ toolName, args }) =>
      this.execute({ toolName, args, ctx }).catch(err => ({
        success: false,
        content: err instanceof Error ? err.message : String(err),
      } as ToolResult))
    );

    return Promise.all(promises);
  }

  /**
   * Validate tool arguments against schema
   */
  validateArgs(
    toolName: string,
    args: Record<string, unknown>
  ): { valid: boolean; errors?: string[] } {
    const tool = this.registry.get(toolName);
    if (!tool) {
      return { valid: false, errors: [`Tool "${toolName}" not found`] };
    }

    const errors: string[] = [];
    const schema = tool.schema;

    // Check required fields
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in args)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Check type validation (Phase 2+ enhancement)
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (key in args && prop && typeof prop === 'object' && 'type' in prop) {
          const actualType = typeof args[key];
          const expectedType = (prop as { type: string }).type;
          if (expectedType === 'string' && actualType !== 'string') {
            errors.push(`Field "${key}" should be string, got ${actualType}`);
          } else if (expectedType === 'number' && actualType !== 'number') {
            errors.push(`Field "${key}" should be number, got ${actualType}`);
          } else if (expectedType === 'boolean' && actualType !== 'boolean') {
            errors.push(`Field "${key}" should be boolean, got ${actualType}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }
}

// ============================================================================
// Phase 1+: Extended ToolExecutor with context factory
// ============================================================================

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  clawDir: string;
  fs: FileSystem;
  llm?: LLMOrchestrator;
  taskSystem?: TaskScheduler;
  profile?: ToolProfile;
  subagentMaxSteps?: number;
  auditWriter?: Audit;
}

/**
 * Extended ToolExecutor with context factory
 * Use this for creating executable contexts
 */
export class ToolExecutor extends ToolExecutorImpl {
  private clawDir: string;
  private fs: FileSystem;
  private llm?: LLMOrchestrator;
  private profile: ToolProfile;
  private subagentMaxSteps?: number;
  private auditWriter?: Audit;

  constructor(options: ToolExecutorOptions) {
    super(options.registry);
    this.clawDir = options.clawDir;
    this.fs = options.fs;
    this.llm = options.llm;
    this.taskSystem = options.taskSystem;
    this.profile = options.profile ?? 'full';
    this.subagentMaxSteps = options.subagentMaxSteps;
    this.auditWriter = options.auditWriter;
  }

  /**
   * Create an execution context
   */
  getExecContext(
    profile: ToolProfile,
    options: { clawId: string; maxSteps?: number; signal?: AbortSignal; callerType?: CallerType; originClawId?: string }
  ): ExecContextImpl {
    return new ExecContextImpl({
      clawId: options.clawId,
      clawDir: this.clawDir,
      profile,
      callerType: options.callerType ?? 'claw',
      fs: this.fs,
      llm: this.llm,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      signal: options.signal,
      subagentMaxSteps: this.subagentMaxSteps,
      originClawId: options.originClawId,
      auditWriter: this.auditWriter,
    });
  }
}

/**
 * Factory: createToolExecutor
 * 装配期构造 ToolExecutorImpl / 承 phase212 D.1 工厂模板.
 * 签名对齐 ctor: (registry, timeoutMs?).
 */
export function createToolExecutor(
  registry: ToolRegistryImpl,
  timeoutMs?: number,
): ToolExecutorImpl {
  return new ToolExecutorImpl(registry, timeoutMs);
}
