/**
 * ContextInjector — context load audit (phase 646 P1.3)
 *
 * Tests:
 * - FNF silent: AGENTS.md/MEMORY.md not found → 0 audit
 * - non-FNF audit: AGENTS.md read throws PermissionError → audit LOAD_FAILED
 * - contractManager.loadActive throws non-FNF → audit LOAD_FAILED file=contract
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextInjector } from '../../../src/core/l4_context_manager/injector.js';
import { FileNotFoundError } from '../../../src/foundation/fs/types.js';
import { PermissionError } from '../../../src/core/permissions/errors.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';

describe('ContextInjector — context load audit (phase 646 P1.3)', () => {
  it.each([
    { name: 'FNF silent: AGENTS.md not found → 0 audit', file: 'AGENTS.md', err: () => new FileNotFoundError('AGENTS.md'), auditCalls: 0, partsKey: 'agents' as const },
    { name: 'non-FNF audit: AGENTS.md read throws PermissionError → audit LOAD_FAILED', file: 'AGENTS.md', err: () => new PermissionError('denied'), auditCalls: 1, partsKey: 'agents' as const },
    { name: 'FNF silent: MEMORY.md not found → 0 audit', file: 'MEMORY.md', err: () => new FileNotFoundError('MEMORY.md'), auditCalls: 0, partsKey: 'memory' as const },
    { name: 'non-FNF audit: MEMORY.md read throws PermissionError → audit LOAD_FAILED', file: 'MEMORY.md', err: () => new PermissionError('denied'), auditCalls: 1, partsKey: 'memory' as const },
  ])('$name', async ({ file, err, auditCalls, partsKey }) => {
    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const mockFs = {
      read: vi.fn().mockImplementation(async (path: string) => {
        if (path === file) throw err();
        return '';
      }),
    };
    const injector = new ContextInjector({ fs: mockFs as any, audit: mockAudit as any });

    const parts = await injector.buildParts();

    expect(mockAudit.write).toHaveBeenCalledTimes(auditCalls);
    if (auditCalls > 0) {
      expect(mockAudit.write).toHaveBeenCalledWith(
        DIALOG_AUDIT_EVENTS.LOAD_FAILED,
        `file=${file}`,
        expect.stringContaining('reason='),
      );
    }
    expect(parts[partsKey]).toBe('');
  });

  it('contractManager.loadActive throws non-FNF → audit LOAD_FAILED file=contract', async () => {
    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const mockFs = {
      read: vi.fn().mockResolvedValue(''),
    };
    const mockContractManager = {
      loadActive: vi.fn().mockRejectedValue(new Error('disk corrupted')),
    };
    const injector = new ContextInjector({
      fs: mockFs as any,
      contractManager: mockContractManager as any,
      audit: mockAudit as any,
    });

    const parts = await injector.buildParts();

    expect(mockAudit.write).toHaveBeenCalledTimes(1);
    expect(mockAudit.write).toHaveBeenCalledWith(
      DIALOG_AUDIT_EVENTS.LOAD_FAILED,
      'file=contract',
      expect.stringContaining('reason='),
    );
    expect(parts.contract).toBe('');
  });

  it('contractManager.loadActive throws FileNotFoundError → silent (0 audit)', async () => {
    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const mockFs = {
      read: vi.fn().mockResolvedValue(''),
    };
    const mockContractManager = {
      loadActive: vi.fn().mockRejectedValue(new FileNotFoundError('contract')),
    };
    const injector = new ContextInjector({
      fs: mockFs as any,
      contractManager: mockContractManager as any,
      audit: mockAudit as any,
    });

    const parts = await injector.buildParts();

    expect(mockAudit.write).not.toHaveBeenCalled();
    expect(parts.contract).toBe('');
  });
});
