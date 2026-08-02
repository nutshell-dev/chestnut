/**
 * Phase 1269 Step D — ToolExecutor timeout cleanup barrier
 *
 * Before this phase, the timeout promise could win the race and return while
 * the execution loser kept running without constraint. Now the executor
 * aborts the merged controller and waits a bounded cleanup barrier
 * (TOOL_EXEC_CLEANUP_BUDGET_MS) before returning the timeout result.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { TOOL_EXEC_CLEANUP_BUDGET_MS } from '../../../src/foundation/tools/constants.js';
import {
  PROCESS_EXEC_SIGKILL_GRACE_MS,
  PROCESS_EXEC_GROUP_KILL_CONFIRM_MS,
} from '../../../src/foundation/process-exec/constants.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { Tool } from '../../../src/foundation/tool-protocol/index.js';
import type { ExecContext } from '../../../src/foundation/tool-protocol/index.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { makeAudit } from '../../helpers/audit.js';

describe('ToolExecutor timeout cleanup barrier (phase 1269 Step D)', () => {
  let registry: ToolRegistryImpl;
  const mockFs = {} as FileSystem;

  beforeEach(() => {
    registry = new ToolRegistryImpl();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeCtx = (auditWriter?: ExecContext['auditWriter']) =>
    makeExecContext({ fs: mockFs, ...(auditWriter ? { auditWriter } : {}) });

  it('cleanup budget covers L1 worst-case exec termination (constant relationship lock)', () => {
    expect(TOOL_EXEC_CLEANUP_BUDGET_MS).toBeGreaterThanOrEqual(
      PROCESS_EXEC_SIGKILL_GRACE_MS + PROCESS_EXEC_GROUP_KILL_CONFIRM_MS,
    );
  });

  it('timeout → abort → loser settles inside barrier: order preserved, timeout result kept (反向 1/4)', async () => {
    // CLEANUP_SETTLE_MS: loser's settle delay after abort — well inside
    // TOOL_EXEC_CLEANUP_BUDGET_MS (3000ms) so the barrier observes the settle.
    // EXECUTION_TIMEOUT_MS: fires the timeout winner before the loser settles
    // naturally; > CLEANUP_SETTLE_MS so the abort path is exercised first.
    const CLEANUP_SETTLE_MS = 100;
    const EXECUTION_TIMEOUT_MS = 200;
    const events: string[] = [];
    const tool: Tool = {
      name: 'exec-like',
      description: 'settles 100ms after abort',
      schema: { type: 'object' },
      readonly: false,
      idempotent: false,
      execute: async (_args, ctx) => {
        await new Promise<void>((resolve) => {
          ctx.signal?.addEventListener('abort', () => {
            events.push('abort_received');
            setTimeout(() => {
              events.push('cleanup_done');
              resolve();
            }, CLEANUP_SETTLE_MS);
          }, { once: true });
        });
        return { success: true, content: 'late success' };
      },
    };
    registry.register(tool);
    const { audit, events: auditEvents } = makeAudit();
    const executor = new ToolExecutorImpl(registry, 60_000);

    const result = await executor.execute({
      toolName: 'exec-like', args: {}, ctx: makeCtx(audit), timeoutMs: EXECUTION_TIMEOUT_MS,
    });

    expect(events).toEqual(['abort_received', 'cleanup_done']);
    expect(result.success).toBe(false);
    expect(result.content).toContain('execution limit'); // ToolTimeoutError, not late success
    expect(result.content).not.toContain('late success');
    const toolExec = auditEvents.filter(([t]) => t === 'tool_exec');
    expect(toolExec).toHaveLength(1);
    expect(toolExec[0]).toContain('cleanup=settled');
    // Late result must be audited, not silently dropped (反向 4).
    const loserOk = auditEvents.filter(
      ([t, ...cols]) => t === 'tool_exec_race_loser' && cols.includes('late_result_ignored'),
    );
    expect(loserOk).toHaveLength(1);
    expect(loserOk[0]).toContain('ok');
  });

  it('abort-ignoring tool: executor returns after cleanup budget and audits cleanup=pending (反向 3)', async () => {
    vi.useFakeTimers();
    // EXECUTION_TIMEOUT_MS: fires the timeout winner while the tool keeps
    // ignoring abort; the executor must then wait exactly the cleanup budget.
    const EXECUTION_TIMEOUT_MS = 200;
    const tool: Tool = {
      name: 'stubborn',
      description: 'ignores abort forever',
      schema: { type: 'object' },
      readonly: true,
      idempotent: true,
      execute: async () => {
        await new Promise(() => {}); // never settles, ignores ctx.signal
        return { success: true, content: '' };
      },
    };
    registry.register(tool);
    const { audit, events: auditEvents } = makeAudit();
    const executor = new ToolExecutorImpl(registry, 60_000);

    const start = Date.now();
    const pendingResult = executor.execute({
      toolName: 'stubborn', args: {}, ctx: makeCtx(audit), timeoutMs: EXECUTION_TIMEOUT_MS,
    });
    await vi.advanceTimersByTimeAsync(EXECUTION_TIMEOUT_MS + TOOL_EXEC_CLEANUP_BUDGET_MS);
    const result = await pendingResult;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.content).toContain('execution limit');
    expect(elapsed).toBe(EXECUTION_TIMEOUT_MS + TOOL_EXEC_CLEANUP_BUDGET_MS);
    const toolExec = auditEvents.filter(([t]) => t === 'tool_exec');
    expect(toolExec[0]).toContain('cleanup=pending');
  });

  it('fast normal tool: no cleanup wait, no cleanup field, success audit unchanged (反向 5)', async () => {
    const tool: Tool = {
      name: 'fast',
      description: 'resolves immediately',
      schema: { type: 'object' },
      readonly: true,
      idempotent: true,
      execute: async () => ({ success: true, content: 'done' }),
    };
    registry.register(tool);
    const { audit, events: auditEvents } = makeAudit();
    const executor = new ToolExecutorImpl(registry, 60_000);

    const result = await executor.execute({
      toolName: 'fast', args: {}, ctx: makeCtx(audit), timeoutMs: 5_000,
    });

    expect(result.success).toBe(true);
    // No elapsed wall-clock threshold: result + audit structure already prove
    // the timeout cleanup path was never entered (no cleanup= col, ok status).
    const toolExec = auditEvents.filter(([t]) => t === 'tool_exec');
    expect(toolExec).toHaveLength(1);
    expect(toolExec[0].some((c) => String(c).startsWith('cleanup='))).toBe(false);
    expect(toolExec[0]).toContain('ok');
  });

  it('execution failure before timeout: no cleanup wait, error surfaced as before', async () => {
    const tool: Tool = {
      name: 'failing',
      description: 'rejects quickly',
      schema: { type: 'object' },
      readonly: false,
      idempotent: false,
      execute: async () => {
        throw new Error('boom');
      },
    };
    registry.register(tool);
    const { audit, events: auditEvents } = makeAudit();
    const executor = new ToolExecutorImpl(registry, 60_000);

    const result = await executor.execute({
      toolName: 'failing', args: {}, ctx: makeCtx(audit), timeoutMs: 5_000,
    });

    expect(result.success).toBe(false);
    expect(result.content).toContain('boom');
    // No elapsed wall-clock threshold: error content + audit structure prove
    // the failure surfaced directly without entering the cleanup path.
    const toolExec = auditEvents.filter(([t]) => t === 'tool_exec');
    expect(toolExec[0].some((c) => String(c).startsWith('cleanup='))).toBe(false);
  });
});
