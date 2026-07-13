/**
 * verification-notify retry-state-machine tests (Phase 968)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleVerificationErrorRetry } from '../../../src/core/contract/verification-notify.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    audit: makeMockAudit() as unknown as VerificationContext['audit'],
    notifyClaw: vi.fn(),
    fs: {} as unknown as FileSystem,
    contractDir: vi.fn().mockResolvedValue('contract/active'),
    withProgressLock: vi.fn((_id, fn) => fn()),
    getProgress: vi.fn().mockResolvedValue(null),
    saveProgress: vi.fn().mockResolvedValue(undefined),
    loadContractYaml: vi.fn().mockResolvedValue({
      subtasks: [{ id: 'st1', description: 'desc' }],
      verification_attempts: 3,
    }),
    checkAllSubtasksCompleted: vi.fn().mockResolvedValue(false),
    toolRegistry: {} as VerificationContext['toolRegistry'],
    ...overrides,
  } as VerificationContext;
}

describe('handleVerificationErrorRetry (Phase 968)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not mutate subtask when contract is not running', async () => {
    const contractId = 'c1';
    const subtaskId = 'st1';
    const progress = {
      status: 'paused',
      subtasks: {
        [subtaskId]: { status: 'in_progress', retry_count: 0 },
      },
    };
    const audit = makeMockAudit();
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      audit: audit as unknown as VerificationContext['audit'],
      saveProgress,
      getProgress: vi.fn().mockResolvedValue(progress),
    });

    await handleVerificationErrorRetry(ctx, contractId, subtaskId, 'programming_bug', 'crash');

    expect(saveProgress).not.toHaveBeenCalled();
    expect(progress.subtasks[subtaskId].status).toBe('in_progress');
    expect(audit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.VERIFICATION_RESET_FAILED,
      expect.stringContaining(`contractId=${contractId}`),
      expect.stringContaining(`subtaskId=${subtaskId}`),
      expect.stringContaining('handleVerificationErrorRetry'),
      expect.stringContaining('paused'),
    );
  });

  it('still resets in_progress subtask to todo when contract is running', async () => {
    const contractId = 'c1';
    const subtaskId = 'st1';
    const progress = {
      status: 'running',
      subtasks: {
        [subtaskId]: { status: 'in_progress', retry_count: 0 },
      },
    };
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      saveProgress,
      getProgress: vi.fn().mockResolvedValue(progress),
    });

    await handleVerificationErrorRetry(ctx, contractId, subtaskId, 'programming_bug', 'crash');

    expect(saveProgress).toHaveBeenCalledTimes(1);
    expect(progress.subtasks[subtaskId].status).toBe('todo');
    expect(progress.subtasks[subtaskId].retry_count).toBe(1);
  });
});
