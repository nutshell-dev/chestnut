/**
 * @module L2.Tools
 * Tool Executor - Implementation
 *
 * phase 501: 4 interface 抽 to types.ts (C-α 极保守整理性)
 */

import * as path from 'path';
import { formatErr } from "../utils/index.js";
import { ExecContextImpl, cloneExecContext } from './context.js';

import {
  ToolTimeoutError,
} from '../errors.js';
import { CLAWSPACE_DIR } from '../claw-paths.js';
import type { ExecContext } from './types.js';
import type { ToolGroup } from './types.js';
import type { PermissionChecker } from '../tool-protocol/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import type { ToolProfile } from '../tool-protocol/index.js';
import type { FileSystem } from '../fs/types.js';
import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { AuditLog } from '../audit/index.js';
import type { AbortReason } from '../llm-provider/index.js';
import type { ScheduleAsyncTool } from './async-dispatch.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from './constants.js';
import { TOOL_AUDIT_EVENTS } from './audit-events.js';
import type {
  ToolRegistry,
  ExecuteOptions,
  IToolExecutor,
  ToolExecutorOptions,
} from './types.js';
import { safeNumber } from '../utils/index.js';


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
      ctx.auditWriter?.write(
        TOOL_AUDIT_EVENTS.TOOL_NOT_FOUND,
        `toolName=${toolName}`,
        `caller=${ctx.callerLabel}`,
      );
      return {
        success: false,
        content: `Tool '${toolName}' not found in registry. Available tools depend on caller profile.`,
      };
    }

    const timeoutMs = options.timeoutMs ?? tool.defaultTimeoutMs ?? this.defaultTimeoutMs;

    // 2. Schema validation (simple check)
    const validation = this.validateArgs(toolName, args);
    if (!validation.valid) {
      const errMsg = validation.errors?.[0] ?? 'Invalid input';
      ctx.auditWriter?.write(
        TOOL_AUDIT_EVENTS.TOOL_INVALID_INPUT,
        `toolName=${toolName}`,
        `error=${errMsg}`,
        `caller=${ctx.callerLabel}`,
      );
      return {
        success: false,
        content: `Invalid input for tool '${toolName}': ${errMsg}`,
      };
    }

    // Async path: tool lifecycle owned by AsyncTaskSystem, no signal merge here.
    // 4. Async path: write fs pending file, watcher will ingest and dispatch
    if (options.async) {
      if (!tool.group || !ctx.allowedGroups?.has(tool.group)) {
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.TOOL_ASYNC_REJECTED,
          toolName,
          options.toolUseId ?? '',
          `reason=group_membership`,
          `caller=${ctx.callerLabel}`,
          `group=${tool.group ?? 'undefined'}`,
        );
        return { success: false, content: 'Async mode is not available for this caller.' };
      }
      if (!tool.supportsAsync) {
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.TOOL_ASYNC_REJECTED,
          toolName,
          options.toolUseId ?? '',
          `reason=unsupported`,
        );
        return { success: false, content: `Tool "${toolName}" does not support async mode.` };
      }
      if (!this.scheduleAsyncTool) {
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.TOOL_ASYNC_REJECTED,
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
        callerLabel: ctx.callerLabel === 'claw' ? undefined : ctx.callerLabel,
        toolUseId: options.toolUseId,
      });
      ctx.auditWriter?.write(
        TOOL_AUDIT_EVENTS.TOOL_ASYNC_START,
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
    const timeoutId = setTimeout(() => timeoutController.abort({ type: 'tool_timeout', ms: timeoutMs } satisfies AbortReason), timeoutMs);

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
    timeoutPromise.catch(() => {
      // silent: race loser — timeoutPromise rejects (ToolTimeoutError) when main execution wins; real error path is executionPromise.catch above
    });

    const ctxWithSignal = cloneExecContext(ctx, { signal: mergedSignal, currentToolUseId: options.toolUseId });

    // phase 1406: caller-access gate. Tools that did not declare
    // `accessesCaller: true` are wrapped to throw + audit-emit when calling
    // `ctx.getCallerSnapshot()`. Tools that declared but receive a ctx
    // without a bound provider also see the throw (Assembly装配 omission).
    const declaredAccess = tool.accessesCaller === true;
    if (!declaredAccess) {
      const audit = ctx.auditWriter;
      const toolNameLocal = toolName;
      ctxWithSignal.getCallerSnapshot = async () => {
        audit?.write(
          TOOL_AUDIT_EVENTS.TOOL_CALLER_ACCESS_VIOLATION,
          toolNameLocal,
          options.toolUseId ?? '',
          'reason=accessesCaller_not_declared',
        );
        audit?.write(
          TOOL_AUDIT_EVENTS.INVARIANT_VIOLATION,
          `site=executor.ts:172`,
          `kind=caller_access_not_declared`,
          `toolName=${toolNameLocal}`,
        );
        throw new Error(
          `[INVARIANT VIOLATION] tools/executor: Tool '${toolNameLocal}' did not declare accessesCaller=true ` +
          `but called ctx.getCallerSnapshot()`,
        );
      };
    } else if (typeof ctxWithSignal.getCallerSnapshot !== 'function') {
      const audit = ctx.auditWriter;
      const toolNameLocal = toolName;
      ctxWithSignal.getCallerSnapshot = async () => {
        audit?.write(
          TOOL_AUDIT_EVENTS.TOOL_CALLER_ACCESS_VIOLATION,
          toolNameLocal,
          options.toolUseId ?? '',
          'reason=provider_not_bound',
        );
        audit?.write(
          TOOL_AUDIT_EVENTS.INVARIANT_VIOLATION,
          `site=executor.ts:188`,
          `kind=caller_access_provider_not_bound`,
          `toolName=${toolNameLocal}`,
        );
        throw new Error(
          `[INVARIANT VIOLATION] tools/executor: Tool '${toolNameLocal}' declared accessesCaller=true but ExecContext ` +
          `was constructed without getCallerSnapshot provider`,
        );
      };
    }

    const executionPromise = tool.execute(args, ctxWithSignal);
    executionPromise.catch((err: unknown) => {
      // race loser audit：execution 真实抛错但 timeoutPromise 先 race 赢、winner audit 仅记 ToolTimeoutError、
      // 此处补 loser 真实 root cause 留痕（D2 信息不丢失）
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      ctx.auditWriter?.write(
        TOOL_AUDIT_EVENTS.TOOL_EXEC_RACE_LOSER,
        toolName,
        'err',
        'context=execution_after_timeout',
        `error=${ctx.auditWriter?.message(errMsg) ?? errMsg}`,
      );
    });

    let result: ToolResult | undefined;
    try {
      result = await Promise.race([executionPromise, timeoutPromise]);
    } catch (err) {
      result = {
        success: false,
        content: formatErr(err),
      };
    } finally {
      clearTimeout(timeoutId);
      timeoutController.abort(); // signal execution to stop / prevent promise leak

      const duration = Date.now() - startTime;
      const auditResult = result ?? { success: false, content: 'unknown' };
      // phase 272 Step A allowlist anchor: 'tool_exec' 沿 phase 614 inline raw 模板 by-design / 0 NEW const
      // 升档条件: 若 future allowlist 漂出 N >= 2 同模板 inline raw -> 抽 TOOL_AUDIT_EVENTS.TOOL_EXEC const
      ctx.auditWriter?.write(
        'tool_exec',
        toolName,
        auditResult.success ? 'ok' : 'err',
        `elapsed_ms=${duration}`,
        `summary=${ctx.auditWriter?.message(auditResult.content ?? '') ?? (auditResult.content ?? '')}`,
      );
    }

    return result!;
  }

  /**
   * Get tool schema by name
   */
  getToolSchema(name: string): import('../llm-provider/types.js').JSONSchema7 | undefined {
    const tool = this.registry.get(name);
    return tool?.schema;
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
      return this.execute({
        toolName,
        args,
        ctx,
        timeoutMs: safeNumber((args as Record<string, unknown>)?.timeoutMs),
      }).catch(err => ({
        success: false,
        content: formatErr(err),
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
      return;
    } else if (expectedType === 'number' && actualType !== 'number') {
      errors.push(`Field "${path}" should be number, got ${actualType}`);
      return;
    } else if (expectedType === 'integer' && (actualType !== 'number' || !Number.isInteger(value as number))) {
      errors.push(`Field "${path}" should be integer, got ${actualType === 'number' ? 'non-integer number' : actualType}`);
      return;
    } else if (expectedType === 'boolean' && actualType !== 'boolean') {
      errors.push(`Field "${path}" should be boolean, got ${actualType}`);
      return;
    }

    // phase 364 D2 (review-2026-06-13): enforce schema 子约束 enum / minLength /
    // maxLength / minimum / maximum。type check 已过、value 是 actualType。
    // 旧 validateArgs 仅 type、LLM 看 schema 说必 enum 之一但 executor 不 enforce →
    // 违约值进 tool 内部炸或返怪结果。
    const schema = propSchema as {
      enum?: unknown[];
      minLength?: number;
      maxLength?: number;
      minimum?: number;
      maximum?: number;
      pattern?: string;
    };
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      const allowed = schema.enum.map(e => JSON.stringify(e)).join(', ');
      errors.push(`Field "${path}" must be one of [${allowed}], got ${JSON.stringify(value)}`);
      return;
    }
    if (expectedType === 'string') {
      const s = value as string;
      if (typeof schema.minLength === 'number' && s.length < schema.minLength) {
        errors.push(`Field "${path}" must have length >= ${schema.minLength}, got ${s.length}`);
      }
      if (typeof schema.maxLength === 'number' && s.length > schema.maxLength) {
        errors.push(`Field "${path}" must have length <= ${schema.maxLength}, got ${s.length}`);
      }
      // phase 446 (review): pattern 子约束、对齐 enum/minLength/maxLength 等已 enforce 项
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(s)) {
        errors.push(`Field "${path}" must match pattern /${schema.pattern}/, got ${JSON.stringify(s)}`);
      }
    }
    if (expectedType === 'number' || expectedType === 'integer') {
      const n = value as number;
      if (typeof schema.minimum === 'number' && n < schema.minimum) {
        errors.push(`Field "${path}" must be >= ${schema.minimum}, got ${n}`);
      }
      if (typeof schema.maximum === 'number' && n > schema.maximum) {
        errors.push(`Field "${path}" must be <= ${schema.maximum}, got ${n}`);
      }
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
  private fs: FileSystem;
  private fsFactory?: (baseDir: string) => FileSystem;
  private llm?: LLMOrchestrator;
  private subagentMaxSteps?: number;
  private auditWriter?: AuditLog;
  constructor(options: ToolExecutorOptions) {
    super(options.registry, options.defaultTimeoutMs, options.scheduleAsyncTool);
    this.clawDir = options.clawDir;
    this.syncDir = options.syncDir;
    this.workspaceDir = options.workspaceDir ?? path.join(options.clawDir, CLAWSPACE_DIR);
    this.fs = options.fs;
    this.fsFactory = options.fsFactory;
    this.llm = options.llm;
    this.subagentMaxSteps = options.subagentMaxSteps;
    this.auditWriter = options.auditWriter;
  }

  /**
   * Create an execution context
   */
  getExecContext(
    profile: ToolProfile,
    options: { clawId: string; maxSteps: number; signal?: AbortSignal; allowedGroups: ReadonlySet<ToolGroup>; callerLabel: string; originClawId?: string; permissionChecker?: PermissionChecker; subagentTaskId?: string }
  ): ExecContextImpl {
    return new ExecContextImpl({
      clawId: options.clawId,
      clawDir: this.clawDir,
      workspaceDir: this.workspaceDir,
      syncDir: this.syncDir,
      profile,
      allowedGroups: options.allowedGroups,
      callerLabel: options.callerLabel,
      permissionChecker: options.permissionChecker,
      fs: this.fs,
      ...(this.fsFactory ? { fsFactory: this.fsFactory } : {}),
      llm: this.llm,
      maxSteps: options.maxSteps,
      signal: options.signal,
      subagentMaxSteps: this.subagentMaxSteps,
      originClawId: options.originClawId,
      auditWriter: this.auditWriter,
      registry: this.registry,
      subagentTaskId: options.subagentTaskId,
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
