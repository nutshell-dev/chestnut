/**
 * @module L2.Tools
 * Tool Executor - Implementation
 *
 * phase 501: 4 interface + escapeForLog 抽 to types.ts (C-α 极保守整理性)
 */

import * as path from 'path';
import { ExecContextImpl, cloneExecContext } from './context.js';

import {
  ToolNotFoundError,
  ToolTimeoutError,
  ToolInvalidInputError,
} from '../../types/errors.js';
import { CLAWSPACE_DIR } from '../../types/paths.js';
import type { CallerType, ExecContext } from '../tool-protocol/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import type { ToolProfile } from '../../types/config.js';
import type { FileSystem } from '../fs/types.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { AuditLog } from '../audit/index.js';
import type { ScheduleAsyncTool } from './async-dispatch.js';
import type { DialogStore } from '../dialog-store/index.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from './constants.js';
import {
  escapeForLog,
  type ToolRegistry,
  type ExecuteOptions,
  type IToolExecutor,
  type ToolExecutorOptions,
} from './types.js';

// Re-export types from ./types.js for caller compat (18 caller 0 改)
export type {
  ToolRegistry,
  ExecuteOptions,
  IToolExecutor,
  ToolExecutorOptions,
} from './types.js';

/**
 * Tool execution implementation
 */
export class ToolExecutorImpl implements IToolExecutor {
  constructor(
    protected registry: ToolRegistry,
    private defaultTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
    private scheduleAsyncTool?: ScheduleAsyncTool,
  ) {}

  /**
   * Execute a single tool
   */
  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const { toolName, args, ctx } = options;
    const startTime = Date.now();

    // 1. Find tool
    const tool = this.registry.get(toolName);
    if (!tool) {
      throw new ToolNotFoundError(toolName);
    }

    const timeoutMs = options.timeoutMs ?? tool.defaultTimeoutMs ?? this.defaultTimeoutMs;

    // 2. Schema validation (simple check)
    const validation = this.validateArgs(toolName, args);
    if (!validation.valid) {
      throw new ToolInvalidInputError(toolName, validation.errors?.[0] ?? 'Invalid input');
    }

    // Async path: tool lifecycle owned by AsyncTaskSystem, no signal merge here.
    // 4. Async path: write fs pending file, watcher will ingest and dispatch
    if (options.async) {
      if (ctx.callerType !== 'claw') {
        ctx.auditWriter?.write(
          'tool_async_rejected',
          toolName,
          options.toolUseId ?? '',
          `reason=caller_type`,
          `caller=${ctx.callerType}`,
        );
        return { success: false, content: 'Async mode is not available for subagents.' };
      }
      if (!tool.supportsAsync) {
        ctx.auditWriter?.write(
          'tool_async_rejected',
          toolName,
          options.toolUseId ?? '',
          `reason=unsupported`,
        );
        return { success: false, content: `Tool "${toolName}" does not support async mode.` };
      }
      if (!this.scheduleAsyncTool) {
        ctx.auditWriter?.write(
          'tool_async_rejected',
          toolName,
          options.toolUseId ?? '',
          `reason=dispatch_unconfigured`,
        );
        return { success: false, content: 'Async tool dispatch not configured.' };
      }
      const taskId = await this.scheduleAsyncTool({
        toolName,
        args,
        parentClawId: ctx.clawId,
        parentClawDir: ctx.clawDir,
        isIdempotent: tool.idempotent,
        maxRetries: tool.idempotent ? 2 : 0,
        retryCount: 0,
        callerType: ctx.callerType === 'claw' ? undefined : ctx.callerType,
        toolUseId: options.toolUseId,
        isShadow: ctx.isShadow,
      });
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
    timeoutPromise.catch(() => {});

    const ctxWithSignal = cloneExecContext(ctx, { signal: mergedSignal, currentToolUseId: options.toolUseId });
    const executionPromise = tool.execute(args, ctxWithSignal);
    executionPromise.catch((err: unknown) => {
      // race loser audit：execution 真实抛错但 timeoutPromise 先 race 赢、winner audit 仅记 ToolTimeoutError、
      // 此处补 loser 真实 root cause 留痕（D2 信息不丢失）/ 沿 phase 614 inline 'tool_exec' 模板、0 NEW const
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      ctx.auditWriter?.write(
        'tool_exec_race_loser',
        toolName,
        'err',
        'context=execution_after_timeout',
        `error=${escapeForLog(errMsg)}`,
      );
    });

    let result: ToolResult | undefined;
    try {
      result = await Promise.race([executionPromise, timeoutPromise]);
    } catch (err) {
      result = {
        success: false,
        content: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;
      const auditResult = result ?? { success: false, content: 'unknown' };
      ctx.auditWriter?.write(
        'tool_exec',
        toolName,
        auditResult.success ? 'ok' : 'err',
        `elapsed_ms=${duration}`,
        `summary=${escapeForLog(auditResult.content ?? '')}`,
      );
    }

    return result!;
  }

  /**
   * Execute multiple read-only tools in parallel
   */
  async executeParallel(
    batch: Array<{ toolName: string; args: Record<string, unknown> }>,
    ctx: ExecContext
  ): Promise<(ToolResult | null)[]> {
    // Invariant: readonly tools are sync-only by design.
    // executeParallel only invokes readonly tools (filter line 161 below); they
    // never enter the async dispatch path, so toolUseId is intentionally not
    // forwarded here. Enforced by tests/foundation/tools/readonly-supports-async-mutex.test.ts.
    const promises = batch.map(({ toolName, args }) => {
      const tool = this.registry.get(toolName);
      if (tool?.readonly !== true) return Promise.resolve(null);
      return this.execute({ toolName, args, ctx }).catch(err => ({
        success: false,
        content: err instanceof Error ? err.message : String(err),
      } as ToolResult));
    });

    return Promise.all(promises);
  }

  /**
   * Recursively validate a value against a schema property.
   * Supports array items, nested objects, and primitives.
   */
  private validateValue(
    value: unknown,
    propSchema: Record<string, unknown>,
    path: string,
    errors: string[],
  ): void {
    if (!propSchema || typeof propSchema !== 'object' || !('type' in propSchema)) return;

    const expectedType = (propSchema as { type: string }).type;

    // Array: validate type + recursively validate items
    if (expectedType === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`Field "${path}" should be array, got ${typeof value}`);
        return;
      }
      const itemSchema = (propSchema as { items?: Record<string, unknown> }).items;
      if (itemSchema) {
        for (let i = 0; i < value.length; i++) {
          this.validateValue(value[i], itemSchema, `${path}[${i}]`, errors);
        }
      }
      return;
    }

    // Object: validate type + recursively validate properties + required
    if (expectedType === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`Field "${path}" should be object, got ${typeof value}`);
        return;
      }
      const objValue = value as Record<string, unknown>;
      const objProps = (propSchema as { properties?: Record<string, unknown> }).properties;
      const objRequired = (propSchema as { required?: string[] }).required;

      if (objRequired) {
        for (const req of objRequired) {
          if (!(req in objValue)) {
            errors.push(`Missing required field: ${path}.${req}`);
          }
        }
      }
      if (objProps) {
        for (const [key, val] of Object.entries(objProps)) {
          if (key in objValue) {
            this.validateValue(objValue[key], val as Record<string, unknown>, `${path}.${key}`, errors);
          }
        }
      }
      return;
    }

    // Primitive: string / number / boolean
    const actualType = typeof value;
    if (expectedType === 'string' && actualType !== 'string') {
      errors.push(`Field "${path}" should be string, got ${actualType}`);
    } else if (expectedType === 'number' && actualType !== 'number') {
      errors.push(`Field "${path}" should be number, got ${actualType}`);
    } else if (expectedType === 'boolean' && actualType !== 'boolean') {
      errors.push(`Field "${path}" should be boolean, got ${actualType}`);
    }
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

    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in args)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    if (schema.properties && typeof schema.properties === 'object') {
      const allowedKeys = new Set(Object.keys(schema.properties));
      for (const key of Object.keys(args)) {
        if (!allowedKeys.has(key)) {
          const allowed = Array.from(allowedKeys).sort().join(', ');
          errors.push(`Unknown field "${key}" for tool "${toolName}". Allowed fields: ${allowed}`);
        }
      }
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (key in args && prop && typeof prop === 'object' && 'type' in prop) {
          this.validateValue(args[key], prop as Record<string, unknown>, key, errors);
        }
      }
    } else {
      // 0 参数工具 / args 必须为空
      if (Object.keys(args).length > 0) {
        errors.push(`Tool "${toolName}" accepts no arguments, got: ${Object.keys(args).join(', ')}`);
      }
    }

    return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
  }
}

/**
 * Extended ToolExecutor with context factory
 */
export class ToolExecutor extends ToolExecutorImpl {
  private clawDir: string;
  private syncDir: string;
  private workspaceDir: string;
  private callerClawId?: string;
  private fs: FileSystem;
  private llm?: LLMOrchestrator;
  private subagentMaxSteps?: number;
  private auditWriter?: AuditLog;
  private mainDialogStore?: DialogStore;
  private mainContextSnapshot?: { clawId: string; toolUseId: string };

  constructor(options: ToolExecutorOptions) {
    super(options.registry, options.defaultTimeoutMs, options.scheduleAsyncTool);
    this.clawDir = options.clawDir;
    this.syncDir = options.syncDir;
    this.workspaceDir = options.workspaceDir ?? path.join(options.clawDir, CLAWSPACE_DIR);
    this.callerClawId = options.callerClawId;
    this.fs = options.fs;
    this.llm = options.llm;
    this.subagentMaxSteps = options.subagentMaxSteps;
    this.auditWriter = options.auditWriter;
    this.mainDialogStore = options.mainDialogStore;
    this.mainContextSnapshot = options.mainContextSnapshot;
  }

  /**
   * Create an execution context
   */
  getExecContext(
    profile: ToolProfile,
    options: { clawId: string; maxSteps: number; signal?: AbortSignal; callerType?: CallerType; originClawId?: string; isShadow?: boolean }
  ): ExecContextImpl {
    return new ExecContextImpl({
      clawId: options.clawId,
      clawDir: this.clawDir,
      workspaceDir: this.workspaceDir,
      callerClawId: this.callerClawId,
      syncDir: this.syncDir,
      profile,
      callerType: options.callerType ?? 'claw',
      fs: this.fs,
      llm: this.llm,
      maxSteps: options.maxSteps,
      signal: options.signal,
      subagentMaxSteps: this.subagentMaxSteps,
      originClawId: options.originClawId,
      isShadow: options.isShadow,
      auditWriter: this.auditWriter,
      mainDialogStore: this.mainDialogStore,
      mainContextSnapshot: this.mainContextSnapshot,
      registry: this.registry,
    });
  }
}

/**
 * Factory: createToolExecutor
 */
export function createToolExecutor(
  registry: ToolRegistry,
  timeoutMs?: number,
  scheduleAsyncTool?: ScheduleAsyncTool,
): ToolExecutorImpl {
  return new ToolExecutorImpl(registry, timeoutMs, scheduleAsyncTool);
}
