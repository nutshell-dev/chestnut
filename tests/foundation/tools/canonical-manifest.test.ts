import { describe, expect, it, vi } from 'vitest';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import type { Tool } from '../../../src/foundation/tools/index.js';

function tool(name: string, description = name): Tool {
  return {
    name,
    description,
    schema: { type: 'object', properties: { value: { type: 'string' } } },
    profiles: ['full'],
    readonly: true,
    idempotent: true,
    execute: async () => ({ success: true, content: name }),
  };
}

describe('canonical tool manifest', () => {
  it('freezes registration order and returns the same revision idempotently', () => {
    const registry = new ToolRegistryImpl();
    registry.register(tool('read'));
    registry.register(tool('exec'));

    const first = registry.freeze();
    const second = registry.freeze();

    expect(second).toBe(first);
    expect(first.definitions.map((item) => item.name)).toEqual(['read', 'exec']);
    expect(first.llmTools.map((item) => item.name)).toEqual(['read', 'exec']);
    expect(first.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(first.llmTools)).toBe(true);
  });

  it('allows a same-descriptor handler replacement without changing the revision', () => {
    const syncRegistry = new ToolRegistryImpl();
    const asyncRegistry = new ToolRegistryImpl();
    const syncExec = tool('exec');
    const asyncExec = { ...tool('exec'), execute: vi.fn() };
    syncRegistry.register(syncExec);
    asyncRegistry.register(asyncExec);

    const syncManifest = syncRegistry.freeze();
    const asyncManifest = asyncRegistry.freeze();
    expect(asyncManifest.revision).toBe(syncManifest.revision);
    expect(asyncRegistry.get('exec')).toBe(asyncExec);
    expect(asyncManifest.definitions).toHaveLength(1);
  });

  it('rejects conflicting duplicate descriptors and mutation after freeze', () => {
    const registry = new ToolRegistryImpl();
    registry.register(tool('read'));
    expect(() => registry.register(tool('read', 'different'))).toThrow('Tool descriptor conflict');

    registry.freeze();
    expect(() => registry.register(tool('late'))).toThrow('frozen');
    expect(() => registry.unregister('read')).toThrow('frozen');
    expect(() => registry.replace(tool('read', 'replacement'))).toThrow('frozen');
  });

  it('fails clearly before freeze and formats only the frozen provider view', () => {
    const registry = new ToolRegistryImpl();
    registry.register(tool('read'));
    expect(() => registry.getManifest()).toThrow('before freeze');
    const manifest = registry.freeze();

    const filtered = vi.spyOn(registry, 'getForProfile').mockImplementation(() => {
      throw new Error('provider path must not filter profiles');
    });
    const serialized = registry.formatForLLM(manifest);
    expect(serialized).toEqual(manifest.llmTools);
    expect(serialized).not.toBe(manifest.llmTools);
    expect(filtered).not.toHaveBeenCalled();
  });
});
