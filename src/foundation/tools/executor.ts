/**
 * @module L2.Tools
 * Tool Executor - Implementation
 *
 * phase 501: 4 interface + escapeForLog 抽 to types.ts (C-α 极保守整理性)
 */

import * as path from 'path';
import { ExecContextImpl, cloneExecContext } from './context.js';
import { DEFAULT_MAX_STEPS } from '../../constants.js';
import {
  ToolNotFoundError,
  ToolTimeoutError,
  ToolInvalidInputError,
} from '../../types/errors.js';
import type { CallerType, ExecContext } from '../tool-protocol/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import type { ToolProfile } from '../../types/config.js';
import type { FileSystem } from '../fs/types.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { AuditLog } from '../audit/index.js';
import type { ScheduleAsyncTool } from './async-dispatch.js';
import type { DialogStore } from '../dialog-store/index.js';
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
    private registry: ToolRegistry,
    private defaultTimeoutMs = 60000,
    private scheduleAsyncTool?: ScheduleAsyncTool,
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

    // Async path: tool lifecycle owned by AsyncTaskSystem, no signal merge here.
    // 4. Async path: write fs pending file, watcher will ingest and dispatch
    if (options.async) {
      if (ctx.callerType !== 'claw') {
        return { success: false, content: 'Async mode is not available for subagents.' };
      }
      if (!tool.supportsAsync) {
        return { success: false, content: `Tool "${toolName}" does not support async mode.` };
      }
      if (!this.scheduleAsyncTool) {
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
    executionPromise.catch(() => {});

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
        `ms=${duration}`,
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
  ): Promise<ToolResult[]> {
    const readOnlyCalls = batch.filter(({ toolName }) => {
      const tool = this.registry.get(toolName);
      return tool?.readonly === true;
    });

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

    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in args)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

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

/**
 * Extended ToolExecutor with context factory
 */
export class ToolExecutor extends ToolExecutorImpl {
  private clawDir: string;
  private syncDir: string;
  private workspaceDir: string;
  private fs: FileSystem;
  private llm?: LLMOrchestrator;
  private profile: ToolProfile;
  private subagentMaxSteps?: number;
  private auditWriter?: AuditLog;
  private mainDialogStore?: DialogStore;
  private mainContextSnapshot?: { clawId: string; toolUseId: string };

  constructor(options: ToolExecutorOptions) {
    super(options.registry, undefined, options.scheduleAsyncTool);
    this.clawDir = options.clawDir;
    this.syncDir = options.syncDir;
    this.workspaceDir = options.workspaceDir ?? path.join(options.clawDir, 'clawspace');
    this.fs = options.fs;
    this.llm = options.llm;
    this.profile = options.profile ?? 'full';
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
    options: { clawId: string; maxSteps?: number; signal?: AbortSignal; callerType?: CallerType; originClawId?: string }
  ): ExecContextImpl {
    return new ExecContextImpl({
      clawId: options.clawId,
      clawDir: this.clawDir,
      workspaceDir: this.workspaceDir,
      syncDir: this.syncDir,
      profile,
      callerType: options.callerType ?? 'claw',
      fs: this.fs,
      llm: this.llm,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
      signal: options.signal,
      subagentMaxSteps: this.subagentMaxSteps,
      originClawId: options.originClawId,
      auditWriter: this.auditWriter,
      mainDialogStore: this.mainDialogStore,
      mainContextSnapshot: this.mainContextSnapshot,
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
