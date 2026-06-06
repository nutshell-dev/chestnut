/**
 * verifier-job cancel skip tests (phase 1080)
 *
 * Crash-recovery: verifier reads progress.json on start, skips if status=cancelled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runContractVerifier } from '../../../src/core/contract/verifier-job.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeAudit } from '../../helpers/audit.js';
import type { VerifierConfig } from '../../../src/core/contract/types.js';

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

function makeConfig(overrides: Partial<VerifierConfig> = {}): VerifierConfig {
  return {
    agentId: 'verifier-test-contract-1',
    clawId: 'claw-test',
    clawDir: '/tmp/claw',
    contractId: 'test-contract-1',
    fs: {
      read: vi.fn(),
    } as unknown as VerifierConfig['fs'],
    llm: {} as unknown as VerifierConfig['llm'],
    prompt: 'test prompt',
    toolRegistry: {
      getForProfile: vi.fn().mockReturnValue([]),
    } as unknown as VerifierConfig['toolRegistry'],
    fsFactory: vi.fn(() => ({}) as unknown as VerifierConfig['fs']),
    runSubagent: mockRunSubagent,
    ...overrides,
  };
}

describe('phase 1080: verifier-job cancel skip', () => {
  beforeEach(() => {
    mockRunSubagent.mockReset();
  });

  it('skips verifier when contract status is cancelled', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      read: vi.fn().mockResolvedValue(JSON.stringify({ status: 'cancelled' })),
    };

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toBe('Contract was cancelled before verifier started');
    expect(mockRunSubagent).not.toHaveBeenCalled();

    const skippedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED);
    expect(skippedRow).toBeDefined();
    expect(skippedRow).toContain('agentId=verifier-test-contract-1');
    expect(skippedRow).toContain('reason=contract_cancelled');
  });

  it('runs verifier normally when contract status is active', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      read: vi.fn().mockResolvedValue(JSON.stringify({ status: 'active' })),
    };
    mockRunSubagent.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok' },
    });

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(true);
    expect(mockRunSubagent).toHaveBeenCalledTimes(1);

    const skippedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED);
    expect(skippedRow).toBeUndefined();
  });

  it('runs verifier when progress.json does not exist (ENOENT)', async () => {
    const { audit, events } = makeAudit();
    const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const fs = {
      read: vi.fn().mockRejectedValue(err),
    };
    mockRunSubagent.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok' },
    });

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(true);
    expect(mockRunSubagent).toHaveBeenCalledTimes(1);

    const skippedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED);
    expect(skippedRow).toBeUndefined();
    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeUndefined();
  });

  it('runs verifier when progress.json read fails with non-ENOENT error (audit only)', async () => {
    const { audit, events } = makeAudit();
    const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    const fs = {
      read: vi.fn().mockRejectedValue(err),
    };
    mockRunSubagent.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok' },
    });

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(true);
    expect(mockRunSubagent).toHaveBeenCalledTimes(1);

    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain('agentId=verifier-test-contract-1');
    expect(failedRow).toContain('kind=progress_read_error');
    expect(failedRow).toContain('reason=EACCES: permission denied');
  });

  it('runs verifier when contractId is not provided (backward compat)', async () => {
    const { audit } = makeAudit();
    mockRunSubagent.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok' },
    });

    const result = await runContractVerifier(makeConfig({ contractId: undefined, audit }));

    expect(result.passed).toBe(true);
    expect(mockRunSubagent).toHaveBeenCalledTimes(1);
  });
});
