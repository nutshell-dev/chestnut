/** Phase2125 Step E：saved revision 驱动、可跨 Runtime 实例重建的应用恢复。 */
import { describe, expect, it, vi } from 'vitest';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import type {
  RuntimeConfigApplicationFact,
  RuntimeConfigApplicationStore,
} from '../../../src/core/runtime/types.js';
import type { LLMOrchestratorConfig } from '../../../src/foundation/llm-orchestrator/index.js';

class RecoveryRuntime extends Runtime {
  wire(llm: { reloadConfig: ReturnType<typeof vi.fn> }) {
    (this as any).llm = llm;
  }
  recover() {
    return (this as any)._recoverConfigApplication() as Promise<void>;
  }
}

function config(model: string): LLMOrchestratorConfig {
  return {
    primary: { name: 'mock', model, apiKey: 'secret', apiFormat: 'anthropic' },
    fallbacks: [],
    maxAttempts: 1,
    retryDelayMs: 0,
    events: { emit: () => {} },
  } as LLMOrchestratorConfig;
}

function memoryStore() {
  let fact: (RuntimeConfigApplicationFact & { clawId: string }) | undefined;
  const record = vi.fn(async (input: RuntimeConfigApplicationFact & { clawId: string }) => {
    fact = input;
    return { kind: 'durable' };
  });
  const store: RuntimeConfigApplicationStore = {
    read: vi.fn(() => fact),
    record,
  };
  return { store, record, current: () => fact };
}

function build(opts: {
  initial: LLMOrchestratorConfig;
  saved: LLMOrchestratorConfig;
  revision: string;
  store: RuntimeConfigApplicationStore;
  reload?: ReturnType<typeof vi.fn>;
  publish?: (identity: string) => Promise<{ previousFact: 'missing' }>;
}) {
  const reload = opts.reload ?? vi.fn();
  const llm = { reloadConfig: reload };
  const runtime = new RecoveryRuntime({
    clawId: 'claw-a',
    clawDir: '/unused',
    llmConfig: opts.initial,
    idleTimeoutMs: 0,
    configReloader: () => ({ config: opts.saved, revision: opts.revision }),
    configIdentityOf: (value) => `identity-${value.primary.model}`,
    configApplicationStore: opts.store,
    ...(opts.publish ? { appliedLLMIdentityPublisher: opts.publish } : {}),
    dependencies: { auditWriter: { write: vi.fn() } },
  } as any);
  runtime.wire(llm);
  return { runtime, reload };
}

describe('LLM configuration reload recovery', () => {
  it('无 inbox 时按 saved revision 应用；下一进程对相同事实幂等', async () => {
    const persistent = memoryStore();
    const first = build({
      initial: config('old'), saved: config('new'), revision: '2', store: persistent.store,
    });
    await first.runtime.recover();
    expect(first.reload).toHaveBeenCalledOnce();
    expect(persistent.current()).toMatchObject({
      revision: '2', identity: 'identity-new', outcome: 'applied', publishPending: false,
    });

    const restarted = build({
      initial: config('new'), saved: config('new'), revision: '2', store: persistent.store,
    });
    await restarted.runtime.recover();
    expect(restarted.reload).not.toHaveBeenCalled();
    expect(persistent.record).toHaveBeenCalledTimes(1);
  });

  it('apply 失败持久化失败事实，重启可重试并成功', async () => {
    const persistent = memoryStore();
    const failed = build({
      initial: config('old'), saved: config('new'), revision: '4', store: persistent.store,
      reload: vi.fn(() => { throw new Error('apply rejected'); }),
    });
    await failed.runtime.recover();
    expect(persistent.current()).toMatchObject({ revision: '4', outcome: 'failed' });

    const restarted = build({
      initial: config('old'), saved: config('new'), revision: '4', store: persistent.store,
    });
    await restarted.runtime.recover();
    expect(restarted.reload).toHaveBeenCalledOnce();
    expect(persistent.current()).toMatchObject({ revision: '4', outcome: 'applied' });
  });

  it('相同 identity 的新 saved revision 只推进事实，不重复 reload', async () => {
    const persistent = memoryStore();
    await persistent.record({
      clawId: 'claw-a', processId: 1, revision: '4', identity: 'identity-same',
      outcome: 'applied', publishPending: false,
    });
    const runtime = build({
      initial: config('same'), saved: config('same'), revision: '5', store: persistent.store,
    });
    await runtime.runtime.recover();
    expect(runtime.reload).not.toHaveBeenCalled();
    expect(persistent.current()).toMatchObject({ revision: '5', outcome: 'applied' });
  });

  it('publisher 失败保留 pending，下一进程补偿后清除', async () => {
    const persistent = memoryStore();
    const first = build({
      initial: config('old'), saved: config('new'), revision: '7', store: persistent.store,
      publish: vi.fn().mockRejectedValue(new Error('publish failed')),
    });
    await first.runtime.recover();
    expect(persistent.current()).toMatchObject({ outcome: 'applied', publishPending: true });

    const publish = vi.fn().mockResolvedValue({ previousFact: 'missing' as const });
    const restarted = build({
      initial: config('new'), saved: config('new'), revision: '7', store: persistent.store,
      publish,
    });
    await restarted.runtime.recover();
    expect(restarted.reload).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('identity-new');
    expect(persistent.current()).toMatchObject({ outcome: 'applied', publishPending: false });
  });
});
