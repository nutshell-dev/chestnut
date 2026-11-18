import { describe, expect, it, vi } from 'vitest';
import { ToolExecutorImpl } from '../../../src/foundation/tools/executor.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import type { Tool } from '../../../src/foundation/tools/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { createDoneTool } from '../../../src/core/subagent/tools/done.js';
import { createShadowTool } from '../../../src/core/shadow-system/tools/shadow.js';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';
import { createNotifyClawTool } from '../../../src/core/claw-topology/tools/notify-claw.js';

function context(execution?: ExecContextImpl['execution']) {
  return new ExecContextImpl({
    clawId: 'caller',
    clawDir: '/tmp',
    profile: 'full',
    fs: {} as FileSystem,
    execution,
  });
}

function makeAudit() {
  return { write: vi.fn(), message: (value: string) => value, preview: (value: string) => value } as any;
}

describe('tool execution gate', () => {
  it('denies before schema validation and handler, with revision and caller audit', async () => {
    const registry = new ToolRegistryImpl();
    const execute = vi.fn();
    const tool: Tool = {
      name: 'restricted',
      description: 'restricted',
      schema: { type: 'object', properties: {}, required: ['missing'] },
      profiles: ['full'],
      readonly: false,
      idempotent: false,
      executionGate: () => ({ allowed: false, code: 'tool_profile_denied', reason: 'denied by test gate' }),
      execute,
    };
    registry.register(tool);
    const manifest = registry.freeze();
    const audit = makeAudit();
    const ctx = context({ callerKind: 'restricted-caller' });
    ctx.auditWriter = audit;

    const result = await new ToolExecutorImpl(registry).execute({
      toolName: 'restricted', args: {}, ctx, toolUseId: 'tu-1' as any,
    });

    expect(result).toMatchObject({ success: false, error: 'tool_profile_denied', content: 'denied by test gate' });
    expect(execute).not.toHaveBeenCalled();
    expect(audit.write).toHaveBeenCalledWith(
      'tool_gate_denied',
      'toolName=restricted',
      'callerKind=restricted-caller',
      `manifestRevision=${manifest.revision}`,
      'code=tool_profile_denied',
      'toolUseId=tu-1',
      'trace_id=',
    );
  });

  it('keeps an allowed tool on the normal execution path', async () => {
    const registry = new ToolRegistryImpl();
    const execute = vi.fn().mockResolvedValue({ success: true, content: 'ok' });
    registry.register({
      name: 'read', description: 'read', schema: { type: 'object', properties: {} },
      profiles: ['full'], readonly: true, idempotent: true, execute,
    });
    const result = await new ToolExecutorImpl(registry).execute({ toolName: 'read', args: {}, ctx: context() });
    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects parent done without requesting stop or capturing a result', async () => {
    const registry = new ToolRegistryImpl();
    registry.register(createDoneTool());
    registry.freeze();
    const ctx = context({ callerKind: 'main', allowDone: false });
    const requestStop = vi.spyOn(ctx, 'requestStop');

    const result = await new ToolExecutorImpl(registry).execute({
      toolName: 'done', args: { result: 'must not be captured' }, ctx,
    });
    expect(result).toMatchObject({ success: false, error: 'done_unavailable_in_context' });
    expect(requestStop).not.toHaveBeenCalled();
    expect(ctx.stopRequested).toBe(false);
  });

  it('rejects shadow recursion and summon from a shadow context', async () => {
    const registry = new ToolRegistryImpl();
    registry.register(createShadowTool({ getTurnSnapshot: () => ({}) }));
    registry.register(new SummonTool());
    registry.freeze();
    const ctx = context({ callerKind: 'shadow', allowShadow: false, allowSummon: false });

    const executor = new ToolExecutorImpl(registry);
    const shadow = await executor.execute({ toolName: 'shadow', args: { task: 'nested' }, ctx });
    const summon = await executor.execute({ toolName: 'summon', args: { goal: 'nested' }, ctx });
    expect(shadow).toMatchObject({ success: false, error: 'shadow_recursion_rejected' });
    expect(summon).toMatchObject({ success: false, error: 'summon_unavailable_in_context' });
  });

  it('rejects notify_claw outside motion without invoking external delivery', async () => {
    const registry = new ToolRegistryImpl();
    const notifyClaw = vi.fn();
    const audit = makeAudit();
    registry.register(createNotifyClawTool({
      notifyClaw,
      defaultSource: 'motion',
      authorized: true,
      sink: audit,
      clawLiveness: () => ({ kind: 'dead' }),
      formatClawStatusHint: () => undefined,
      clawExists: () => true,
      hasActiveContract: () => false,
    }));
    registry.freeze();

    const result = await new ToolExecutorImpl(registry).execute({
      toolName: 'notify_claw',
      args: { to: 'worker', body: 'must not send' },
      ctx: context({ callerKind: 'main', allowNotifyClaw: false }),
    });
    expect(result).toMatchObject({ success: false, error: 'notify_claw_motion_only' });
    expect(notifyClaw).not.toHaveBeenCalled();
  });
});
