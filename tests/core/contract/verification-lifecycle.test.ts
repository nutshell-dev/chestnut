/**
 * @module tests/core/contract/verification-lifecycle
 * Phase 951: archiveAndEmit commit-point behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { archiveAndEmit } from '../../../src/core/contract/verification-lifecycle.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';
import { makeContractId } from '../../../src/core/contract/types.js';

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    audit: {
      __brand: 'AuditLog',
      write: vi.fn(),
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    } as unknown as VerificationContext['audit'],
    notifyClaw: vi.fn(),
    onNotify: vi.fn(),
    moveContractToArchive: vi.fn(),
    emitContractCompleted: vi.fn(),
    getProgress: vi.fn().mockResolvedValue(null),
    saveProgress: vi.fn(),
    withProgressLock: vi.fn(),
    verificationMutex: {} as VerificationContext['verificationMutex'],
    contractDir: vi.fn(),
    loadContractYaml: vi.fn(),
    checkAllSubtasksCompleted: vi.fn(),
    toolRegistry: {} as VerificationContext['toolRegistry'],
    ...overrides,
  } as unknown as VerificationContext;
}

function makeYaml() {
  return {
    title: 'Test Contract',
    goal: 'test goal',
    description: 'desc',
    priority: 'normal',
    creator: 'test',
    auth_level: 'auto',
    subtasks: [{ id: 't1', description: 'd1' }],
  } as VerificationContext['loadContractYaml'] extends (...args: any[]) => Promise<infer R> ? NonNullable<R> : never;
}

describe('archiveAndEmit (phase 951)', () => {
  let ctx: VerificationContext;
  let contractYaml: ReturnType<typeof makeYaml>;

  beforeEach(() => {
    ctx = makeCtx();
    contractYaml = makeYaml();
  });

  it('does not archive when emitContractCompleted fails', async () => {
    const contractId = makeContractId('c-1');
    vi.mocked(ctx.moveContractToArchive).mockResolvedValue(undefined);
    vi.mocked(ctx.emitContractCompleted).mockRejectedValue(new Error('emit failed'));

    const result = await archiveAndEmit(ctx, contractId, contractYaml, 'test-context');

    // emit failed before move; contract stays active
    expect(result).toEqual({ archived: false });
    expect(ctx.moveContractToArchive).not.toHaveBeenCalled();
    expect(ctx.withProgressLock).not.toHaveBeenCalled();
    expect(ctx.saveProgress).not.toHaveBeenCalled();

    // emit side effect was attempted
    expect(ctx.emitContractCompleted).toHaveBeenCalledWith(contractId);

    // move-archive-failed audit emitted
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    const moveFailed = auditWrites.find(c => c[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED);
    expect(moveFailed).toBeDefined();
    expect(moveFailed?.some(col => String(col).includes('emitContractCompleted failed, cannot archive'))).toBe(true);
  });

  it('emits completed audit and notifies after successful emit + move', async () => {
    const contractId = makeContractId('c-2');
    vi.mocked(ctx.moveContractToArchive).mockResolvedValue(undefined);
    vi.mocked(ctx.emitContractCompleted).mockResolvedValue(undefined);

    const result = await archiveAndEmit(ctx, contractId, contractYaml, 'test-context');

    expect(result).toEqual({ archived: true });
    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.COMPLETED)).toBe(true);
    expect(ctx.onNotify).toHaveBeenCalled();
  });

  it('returns archived false when moveContractToArchive fails (rollback + audit)', async () => {
    const contractId = makeContractId('c-3');
    vi.mocked(ctx.moveContractToArchive).mockRejectedValue(new Error('disk full'));

    await expect(archiveAndEmit(ctx, contractId, contractYaml, 'test-context')).resolves.toEqual({ archived: false });

    const auditWrites = vi.mocked(ctx.audit.write).mock.calls;
    expect(auditWrites.some(c => c[0] === CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED)).toBe(true);
  });
});
