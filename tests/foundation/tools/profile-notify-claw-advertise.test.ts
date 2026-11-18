import { describe, it, expect } from 'vitest';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { createNotifyClawTool } from '../../../src/core/claw-topology/tools/notify-claw.js';

function registryWithNotify(): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  const fakeAudit = { write: () => {} } as any;
  registry.register(createNotifyClawTool({
    notifyClaw: async () => undefined,
    defaultSource: 'motion',
    authorized: true,
    sink: fakeAudit,
    clawLiveness: () => ({ kind: 'alive', pid: 123 }),
    formatClawStatusHint: () => undefined,
    clawExists: () => true,
    hasActiveContract: () => false,
  }));
  return registry;
}

describe('notify_claw canonical advertise pipeline', () => {
  it('motion runtime gets notify_claw in LLM tools array', () => {
    const registry = registryWithNotify();
    const names = registry.formatForLLM(registry.getForProfile('full')).map(t => t.name);
    expect(names).toContain('notify_claw');
  });

  it('canonical manifest advertises notify_claw independent of execution profile', () => {
    const registry = registryWithNotify();
    const names = registry.formatForLLM(registry.freeze()).map(t => t.name);
    expect(names).toContain('notify_claw');
  });
});
