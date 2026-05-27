import { describe, it, expect, vi } from 'vitest';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';

describe('Tools — async path silent rejection audit (P1.10 / α)', () => {
  function makeRegistry(toolOverrides: { readonly?: boolean; supportsAsync?: boolean }) {
    return {
      get: (name: string) =>
        name === 'testTool'
          ? {
              name: 'testTool',
              description: 'test',
              schema: { type: 'object' },
              readonly: true,
              idempotent: true,
              group: 'fs-read',
              execute: vi.fn(),
              ...toolOverrides,
            }
          : undefined,
    } as any;
  }

  function makeAudit() {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit = {
      write: (type: string, ...cols: (string | number)[]) => {
        events.push([type, ...cols]);
      },
    };
    return { audit, events };
  }

  function makeCtx(callerType: string, audit: ReturnType<typeof makeAudit>['audit'], allowedGroups?: Set<string>) {
    return {
      clawId: 'test',
      clawDir: '/tmp',
      profile: 'full',
      fs: {},
      callerType,
      allowedGroups: allowedGroups ?? new Set(['fs-read']),
      callerLabel: callerType,
      auditWriter: audit,
    } as any;
  }

  it('audits tool_async_rejected with reason=caller_type when subagent dispatches async', async () => {
    const { audit, events } = makeAudit();
    const registry = makeRegistry({ readonly: true, supportsAsync: true });
    const scheduleAsyncTool = vi.fn();
    const executor = new ToolExecutorImpl(registry, 60000, scheduleAsyncTool);
    const ctx = makeCtx('subagent', audit, new Set());

    const result = await executor.execute({
      toolName: 'testTool',
      args: {},
      ctx,
      async: true,
      toolUseId: 'tu1',
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe('Async mode is not available for this caller.');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual([
      'tool_async_rejected',
      'testTool',
      'tu1',
      'reason=group_membership',
      'caller=subagent',
      'group=fs-read',
    ]);
    expect(scheduleAsyncTool).not.toHaveBeenCalled();
  });

  it('audits tool_async_rejected with reason=unsupported when tool.supportsAsync=false', async () => {
    const { audit, events } = makeAudit();
    const registry = makeRegistry({ readonly: true, supportsAsync: false });
    const scheduleAsyncTool = vi.fn();
    const executor = new ToolExecutorImpl(registry, 60000, scheduleAsyncTool);
    const ctx = makeCtx('claw', audit);

    const result = await executor.execute({
      toolName: 'testTool',
      args: {},
      ctx,
      async: true,
      toolUseId: 'tu1',
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe('Tool "testTool" does not support async mode.');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual([
      'tool_async_rejected',
      'testTool',
      'tu1',
      'reason=unsupported',
    ]);
  });

  it('audits tool_async_rejected with reason=dispatch_unconfigured when scheduleAsyncTool is undefined', async () => {
    const { audit, events } = makeAudit();
    const registry = makeRegistry({ readonly: true, supportsAsync: true });
    const executor = new ToolExecutorImpl(registry, 60000, undefined);
    const ctx = makeCtx('claw', audit);

    const result = await executor.execute({
      toolName: 'testTool',
      args: {},
      ctx,
      async: true,
      toolUseId: 'tu1',
    });

    expect(result.success).toBe(false);
    expect(result.content).toBe('Async tool dispatch not configured.');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual([
      'tool_async_rejected',
      'testTool',
      'tu1',
      'reason=dispatch_unconfigured',
    ]);
  });
});
