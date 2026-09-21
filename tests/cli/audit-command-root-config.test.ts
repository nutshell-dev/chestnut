import { describe, expect, it, vi } from 'vitest';
import { auditInfoCommand } from '../../src/cli/commands/audit-info.js';
import { auditLookupCommand } from '../../src/cli/commands/audit-lookup.js';
import { auditQueryCommand } from '../../src/cli/commands/audit-query.js';
import { makeAuditCommandDeps } from '../helpers/audit-command-deps.js';

const fsFactory = vi.fn(() => {
  throw new Error('filesystem must not be reached');
});

describe('Audit CLI RootConfig injection', () => {
  it.each([
    ['query', auditQueryCommand, { claw: 'test-claw', file: 'audit' }],
    ['lookup', auditLookupCommand, { claw: 'test-claw', toolUseId: 'call_1' }],
    ['info', auditInfoCommand, { claw: 'test-claw' }],
  ] as const)('%s propagates global config read failures unchanged', async (_name, command, opts) => {
    const failure = new Error('global config corrupt');
    const deps = makeAuditCommandDeps(fsFactory, { loadGlobal: () => { throw failure; } });

    await expect(command(deps, opts)).rejects.toBe(failure);
  });

  it.each([
    ['query', auditQueryCommand, { claw: 'missing', file: 'audit' }],
    ['lookup', auditLookupCommand, { claw: 'missing', toolUseId: 'call_1' }],
    ['info', auditInfoCommand, { claw: 'missing' }],
  ] as const)('%s maps an absent claw config to the CLI not-found error', async (_name, command, opts) => {
    const deps = makeAuditCommandDeps(fsFactory, { loadClaw: () => undefined });

    await expect(command(deps, opts)).rejects.toThrow('Claw "missing" does not exist');
  });

  it.each([
    ['query', auditQueryCommand, { claw: 'broken', file: 'audit' }],
    ['lookup', auditLookupCommand, { claw: 'broken', toolUseId: 'call_1' }],
    ['info', auditInfoCommand, { claw: 'broken' }],
  ] as const)('%s propagates claw config corruption/IO failures unchanged', async (_name, command, opts) => {
    const failure = new Error('claw config unreadable');
    const deps = makeAuditCommandDeps(fsFactory, { loadClaw: () => { throw failure; } });

    await expect(command(deps, opts)).rejects.toBe(failure);
  });
});
