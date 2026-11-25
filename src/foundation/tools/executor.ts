/**
 * @module L2c.Tools
 * Tool Executor - Implementation
 *
 * phase 501: 4 interface 抽 to types.ts (C-α 极保守整理性)
 */

import { formatErr, newShortUuid } from "../node-utils/index.js";
import type { llmProviderProtocol } from '../llm-provider/index.js';
import { ExecContextImpl, cloneExecContext } from './context.js';

import {
  ToolTimeoutError } from './errors.js';
import type {
  ExecContext,
  Tool,
  ToolExecutionErrorEvidence,
  ToolExecutionFinal,
  ToolExecutionPresentation,
  ToolExecutionRef,
  ToolGateResult,
} from './types.js';
import type { PermissionChecker } from '../tool-protocol/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import type { ToolProfile } from '../tool-protocol/index.js';
import type { FileSystem } from '../fs/index.js';

import type { LLMOrchestrator } from '../llm-orchestrator/index.js';
import type { AuditLog } from '../audit/index.js';
import {
  DEFAULT_TOOL_OUTPUT_BOUNDS,
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_EXEC_CLEANUP_BUDGET_MS,
} from './constants.js';
import { enforceToolResultBounds } from './output-cap.js';
import { ToolExecution, createSettledToolExecution } from './execution.js';
import { ToolExecutionStore } from './execution-store.js';

/** phase 1802: tool 执行 owner 自定义的 abort reason（L1 只承载 opaque evidence） */
type ToolTimeoutAbortReason = { type: 'tool_timeout'; ms: number };
import { TOOL_AUDIT_EVENTS } from './audit-events.js';
import type {
  ToolRegistry,
  ExecuteOptions,
  IToolExecutor,
  ToolExecutorOptions } from './types.js';

const CALLER_SNAPSHOT_ACCESS_GATE_SITE =
  'site=tools/executor:caller_snapshot_access_gate';

// Re-export types from ./types.js for caller compat (18 caller 0 改)
export type {
  ToolRegistry,
  ExecuteOptions,
  IToolExecutor,
  ToolExecutorOptions } from './types.js';

function toSafeNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v));
  return Number.isNaN(n) || !Number.isFinite(n) ? undefined : n;
}

function toExecutionError(error: unknown): ToolExecutionErrorEvidence {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(error.cause !== undefined ? { cause: formatErr(error.cause) } : {}),
    };
  }
  return { name: 'NonErrorToolFailure', message: formatErr(error) };
}

/**
 * Tool execution implementation
 */
export class ToolExecutorImpl implements IToolExecutor {
  protected baseRegistry?: ToolRegistry;

  constructor(
    protected registry: ToolRegistry,
    private defaultTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
    baseRegistry?: ToolRegistry,
  ) {
    this.baseRegistry = baseRegistry;
  }

  /** Begin after the admission/started journal barrier; completion means real settlement. */
  async begin(options: ExecuteOptions): Promise<ToolExecutionRef> {
    const { toolName, args, ctx } = options;
    const startTime = Date.now();
    const executionId = newShortUuid();
    const store = new ToolExecutionStore(ctx, executionId);
    const onObserverError = (error: unknown) => {
      process.stderr.write(`[tools] execution observer failed: ${formatErr(error)}\n`);
    };
    const reject = async (
      presentedResult: ToolResult,
      presentation: ToolExecutionPresentation,
      actualError?: ToolExecutionErrorEvidence,
    ): Promise<ToolExecutionRef> => {
      const base: Omit<ToolExecutionFinal, 'persistence'> = {
        id: executionId,
        outcome: 'rejected',
        presentedResult,
        presentation,
        ...(actualError ? { actualError } : {}),
      };
      const finalWrite = await store.recordFinal(base);
      const final: ToolExecutionFinal = { ...base, persistence: store.persistence(finalWrite) };
      return createSettledToolExecution(executionId, final, onObserverError);
    };

    const tool = this.registry.get(toolName);
    if (!tool) {
      ctx.auditWriter?.write(TOOL_AUDIT_EVENTS.TOOL_NOT_FOUND, `toolName=${toolName}`);
      return reject(await enforceToolResultBounds(ctx, toolName, {
        success: false,
        content: `Tool '${toolName}' not found in registry. Available tools depend on caller profile.`,
      }, DEFAULT_TOOL_OUTPUT_BOUNDS), {
        kind: 'rejected',
        reason: 'tool_not_found',
      });
    }

    // Dynamic execution gate: visibility is manifest-owned, never profile-filtered.
    const gateResult = this.gate(tool, ctx);
    if (!gateResult.allowed) {
      let manifestRevision = ctx.execution?.manifestRevision ?? 'unavailable';
      if (ctx.execution?.manifestRevision === undefined && typeof this.registry.getManifest === 'function') {
        try {
          manifestRevision = this.registry.getManifest()?.revision ?? 'unavailable';
        } catch {
          // silent: pre-freeze execution has no revision; denial evidence remains explicit.
          manifestRevision = 'unfrozen';
        }
      }
      try {
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.TOOL_GATE_DENIED,
          `toolName=${toolName}`,
          `callerKind=${ctx.execution?.callerKind ?? 'legacy'}`,
          `manifestRevision=${manifestRevision}`,
          `code=${gateResult.code}`,
          `toolUseId=${options.toolUseId ?? ''}`,
          `trace_id=${String(ctx.trace_id ?? '')}`,
        );
      } catch (auditError) {
        process.stderr.write(`[tools] gate denial audit failed: ${formatErr(auditError)}\n`);
      }
      return reject(await enforceToolResultBounds(ctx, toolName, {
        success: false,
        error: gateResult.code,
        content: gateResult.reason,
      }, tool.outputBounds ?? DEFAULT_TOOL_OUTPUT_BOUNDS), {
        kind: 'rejected',
        reason: gateResult.code,
      });
    }

    const timeoutMs = options.timeoutMs ?? tool.defaultTimeoutMs ?? this.defaultTimeoutMs;
    const validation = this.validateArgs(toolName, args);
    if (!validation.valid) {
      const errMsg = validation.errors?.[0] ?? 'Invalid input';
      ctx.auditWriter?.write(
        TOOL_AUDIT_EVENTS.TOOL_INVALID_INPUT,
        `toolName=${toolName}`,
        `error=${errMsg}`,
      );
      return reject(await enforceToolResultBounds(ctx, toolName, {
        success: false,
        content: `Invalid input for tool '${toolName}': ${errMsg}`,
      }, tool.outputBounds ?? DEFAULT_TOOL_OUTPUT_BOUNDS), {
        kind: 'rejected',
        reason: 'invalid_input',
      });
    }

    const started = await store.recordStarted(options, timeoutMs);
    if (started.kind === 'failed') {
      const reason = started.error ?? 'started journal write failed';
      return reject({
        success: false,
        error: 'tool_execution_journal_persist_failed',
        content: `Tool '${toolName}' was not started because its execution journal could not be persisted: ${reason}`,
      }, { kind: 'journal_failed', reason }, {
        name: 'ToolExecutionJournalError',
        message: reason,
      });
    }

    const stopController = new AbortController();
    const signals = [stopController.signal];
    if (ctx.signal) signals.push(ctx.signal);
    const mergedSignal = AbortSignal.any(signals);
    const ctxWithSignal = cloneExecContext(ctx, {
      signal: mergedSignal,
      currentToolUseId: options.toolUseId,
    });

    // Caller-access gate remains on the actual per-execution context.
    const declaredAccess = tool.accessesCaller === true;
    if (!declaredAccess) {
      ctxWithSignal.getCallerSnapshot = async () => {
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.TOOL_CALLER_ACCESS_VIOLATION,
          toolName,
          options.toolUseId ?? '',
          'reason=accessesCaller_not_declared',
        );
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.INVARIANT_VIOLATION,
          CALLER_SNAPSHOT_ACCESS_GATE_SITE,
          'kind=caller_access_not_declared',
          `toolName=${toolName}`,
        );
        throw new Error(
          `[INVARIANT VIOLATION] tools/executor: Tool '${toolName}' did not declare accessesCaller=true ` +
          'but called ctx.getCallerSnapshot()',
        );
      };
    } else if (typeof ctxWithSignal.getCallerSnapshot !== 'function') {
      ctxWithSignal.getCallerSnapshot = async () => {
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.TOOL_CALLER_ACCESS_VIOLATION,
          toolName,
          options.toolUseId ?? '',
          'reason=provider_not_bound',
        );
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.INVARIANT_VIOLATION,
          CALLER_SNAPSHOT_ACCESS_GATE_SITE,
          'kind=caller_access_provider_not_bound',
          `toolName=${toolName}`,
        );
        throw new Error(
          `[INVARIANT VIOLATION] tools/executor: Tool '${toolName}' declared accessesCaller=true but ExecContext ` +
          'was constructed without getCallerSnapshot provider',
        );
      };
    }

    const stopWrites: Promise<unknown>[] = [];
    const execution = new ToolExecution(executionId, async (reason) => {
      // Cancellation protection is sent first; the receipt separately reports durability.
      stopController.abort(reason);
      const write = store.recordStop(reason);
      stopWrites.push(write);
      return write;
    }, onObserverError);
    const requestStop = async (reason: unknown) => {
      const receipt = await execution.requestStop(reason);
      ctx.auditWriter?.write(
        TOOL_AUDIT_EVENTS.TOOL_EXECUTION_STOP_REQUESTED,
        `executionId=${executionId}`,
        `toolName=${toolName}`,
        `accepted=${receipt.accepted}`,
        `persisted=${receipt.persisted}`,
        `reason=${ctx.auditWriter?.message(formatErr(reason)) ?? formatErr(reason)}`,
      );
      return receipt;
    };

    let timeoutPresentation: { reason: ToolTimeoutAbortReason; result: ToolResult } | undefined;
    let cleanupState: 'settled' | 'pending' | undefined;
    let cleanupTimer: NodeJS.Timeout | undefined;
    const timeoutId = setTimeout(() => {
      const reason: ToolTimeoutAbortReason = { type: 'tool_timeout', ms: timeoutMs };
      const error = new ToolTimeoutError(toolName, timeoutMs);
      timeoutPresentation = { reason, result: { success: false, content: formatErr(error) } };
      cleanupState = 'settled';
      execution.markTimeout(timeoutPresentation.result, reason);
      void requestStop(reason);
      cleanupTimer = setTimeout(() => {
        cleanupState = 'pending';
        execution.markCleanupPending();
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.TOOL_EXECUTION_CLEANUP_PENDING,
          `executionId=${executionId}`,
          `toolName=${toolName}`,
          `cleanup_ms=${TOOL_EXEC_CLEANUP_BUDGET_MS}`,
        );
      }, TOOL_EXEC_CLEANUP_BUDGET_MS);
    }, timeoutMs);

    const upstreamSignal = ctx.signal;
    const onUpstreamAbort = () => { void requestStop(upstreamSignal?.reason); };
    upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true });
    if (upstreamSignal?.aborted) onUpstreamAbort();

    const clearExecutionControls = () => {
      clearTimeout(timeoutId);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort);
    };

    // Keep the real promise until it settles; no timeout/cleanup race projects completion.
    const executionPromise = Promise.resolve().then(() => tool.execute(args, ctxWithSignal));
    const finish = async (
      settlement: { outcome: 'completed'; result: ToolResult } | { outcome: 'failed'; error: unknown },
    ) => {
      clearExecutionControls();
      const actualError = settlement.outcome === 'failed' ? toExecutionError(settlement.error) : undefined;
      const rawForBounds = settlement.outcome === 'completed'
        ? settlement.result
        : { success: false, content: formatErr(settlement.error) };
      let boundedActualResult: ToolResult;
      try {
        boundedActualResult = await enforceToolResultBounds(
          ctxWithSignal,
          toolName,
          rawForBounds,
          tool.outputBounds ?? DEFAULT_TOOL_OUTPUT_BOUNDS,
        );
      } catch (presentationError) {
        boundedActualResult = {
          success: false,
          error: 'tool_result_presentation_failed',
          content: `Tool result presentation failed: ${formatErr(presentationError)}`,
        };
      }

      const presentedResult = timeoutPresentation?.result ?? boundedActualResult;
      const presentation: ToolExecutionPresentation = timeoutPresentation
        ? { kind: 'timeout', reason: timeoutPresentation.reason }
        : { kind: 'actual' };
      const stopReason = execution.firstStopReason;
      const base: Omit<ToolExecutionFinal, 'persistence'> = {
        id: executionId,
        outcome: settlement.outcome,
        ...(settlement.outcome === 'completed' ? { actualResult: settlement.result } : {}),
        boundedActualResult,
        ...(actualError ? { actualError } : {}),
        presentedResult,
        presentation,
        ...(stopReason !== undefined ? { stopReason } : {}),
      };
      await Promise.all(stopWrites);
      const finalWrite = await store.recordFinal(base);
      const final: ToolExecutionFinal = { ...base, persistence: store.persistence(finalWrite) };

      if (timeoutPresentation) {
        ctx.auditWriter?.write(
          TOOL_AUDIT_EVENTS.TOOL_EXEC_RACE_LOSER,
          toolName,
          settlement.outcome === 'completed' && settlement.result.success ? 'ok' : 'err',
          'context=execution_after_timeout',
          settlement.outcome === 'completed'
            ? 'late_result_retained'
            : `error=${ctx.auditWriter?.message(`${actualError?.name}: ${actualError?.message}`) ?? `${actualError?.name}: ${actualError?.message}`}`,
        );
      }
      ctx.auditWriter?.write(
        'tool_exec',
        toolName,
        presentedResult.success ? 'ok' : 'err',
        `elapsed_ms=${Date.now() - startTime}`,
        ...(cleanupState !== undefined ? [`cleanup=${cleanupState}`] : []),
        `summary=${ctx.auditWriter?.message(presentedResult.content) ?? presentedResult.content}`,
      );
      execution.settle(final);
      ctx.auditWriter?.write(
        TOOL_AUDIT_EVENTS.TOOL_EXECUTION_SETTLED,
        `executionId=${executionId}`,
        `toolName=${toolName}`,
        `outcome=${final.outcome}`,
        `presentation=${final.presentation.kind}`,
        `final_persisted=${final.persistence.final.persisted}`,
      );
    };

    void executionPromise.then(
      (result) => finish({ outcome: 'completed', result }),
      (error: unknown) => finish({ outcome: 'failed', error }),
    );
    return execution;
  }

  /** Compatibility projection: resolve only after the real execution has settled. */
  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const execution = await this.begin(options);
    return (await execution.completion).presentedResult;
  }

  private gate(tool: Tool, ctx: ExecContext): ToolGateResult {
    if (tool.name === 'done' && !(ctx.execution?.allowDone ?? ctx.profile !== 'full')) {
      return {
        allowed: false,
        code: 'done_unavailable_in_context',
        reason: 'done is only available to a subagent execution context with result capture.',
      };
    }
    if (tool.name === 'shadow' && ctx.execution?.allowShadow === false) {
      return {
        allowed: false,
        code: 'shadow_recursion_rejected',
        reason: 'shadow is not callable from within a shadow (no recursion).',
      };
    }
    if (tool.name === 'summon' && ctx.execution?.allowSummon === false) {
      return {
        allowed: false,
        code: 'summon_unavailable_in_context',
        reason: 'Summon is unavailable in the current execution context.',
      };
    }
    if (tool.name === 'notify_claw' && ctx.execution?.allowNotifyClaw === false) {
      return {
        allowed: false,
        code: 'notify_claw_motion_only',
        reason: 'notify_claw is motion-only',
      };
    }
    const ownerResult = tool.executionGate?.(ctx) ?? { allowed: true as const };
    if (!ownerResult.allowed) return ownerResult;
    if (Array.isArray(tool.profiles) && !tool.profiles.includes(ctx.profile)) {
      return {
        allowed: false,
        code: 'tool_profile_denied',
        reason: `Tool '${tool.name}' is not available for execution profile '${ctx.profile}'.`,
      };
    }
    return { allowed: true };
  }

  /**
   * Get tool schema by name
   */
  getToolSchema(name: string): llmProviderProtocol.JSONSchema7 | undefined {
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
    // executeParallel only invokes readonly tools (filter line below); they
    // never enter async dispatch, so toolUseId is intentionally not forwarded here.
    const promises = batch.map(({ toolName, args }) => {
      const tool = this.registry.get(toolName);
      if (tool?.readonly !== true) return Promise.resolve(null);
      return this.execute({
        toolName,
        args,
        ctx,
        timeoutMs: toSafeNumber((args as Record<string, unknown>)?.timeoutMs),
      }).catch(err => enforceToolResultBounds(
        ctx,
        toolName,
        { success: false, content: formatErr(err) },
        tool.outputBounds ?? DEFAULT_TOOL_OUTPUT_BOUNDS,
      ));
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
  private auditWriter?: AuditLog;
  private execution?: ExecContext['execution'];
  constructor(options: ToolExecutorOptions) {
    super(options.registry, options.defaultTimeoutMs, options.baseRegistry);
    this.clawDir = options.clawDir;
    this.syncDir = options.syncDir;
    this.workspaceDir = options.workspaceDir;
    this.fs = options.fs;
    this.fsFactory = options.fsFactory;
    this.llm = options.llm;
    this.auditWriter = options.auditWriter;
    this.execution = options.execution;
  }

  /**
   * Create an execution context
   */
  getExecContext(
    profile: ToolProfile,
    options: { clawId: string; signal?: AbortSignal; permissionChecker?: PermissionChecker; subagentTaskId?: string; trace_id?: import('../audit/index.js').TraceId; execution?: ExecContext['execution'] }
  ): ExecContextImpl {
    return new ExecContextImpl({
      clawId: options.clawId,
      clawDir: this.clawDir,
      workspaceDir: this.workspaceDir,
      syncDir: this.syncDir,
      profile,
      execution: options.execution ?? this.execution,
      permissionChecker: options.permissionChecker,
      fs: this.fs,
      ...(this.fsFactory ? { fsFactory: this.fsFactory } : {}),
      llm: this.llm,
      signal: options.signal,
      auditWriter: this.auditWriter,
      registry: this.registry,
      baseRegistry: this.baseRegistry,
      subagentTaskId: options.subagentTaskId,
      trace_id: options.trace_id,
    });
  }
}

/**
 * Factory: createToolExecutor
 */
export function createToolExecutor(
  registry: ToolRegistry,
  timeoutMs?: number,
): ToolExecutorImpl {
  return new ToolExecutorImpl(registry, timeoutMs);
}
