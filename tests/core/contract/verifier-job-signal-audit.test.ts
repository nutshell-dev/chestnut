/**
 * verifier-job signal + catch audit emit tests (phase 993 / r121 J fork)
 *
 * D.1 signal propagation + D.2 catch audit emit reverse tests.
 * Mirrors verifier-job.test.ts mock pattern + makeAudit fixture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runContractVerifier } from '../../../src/core/contract/verifier-job.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { ToolTimeoutError } from '../../../src/foundation/errors.js';
import { makeAudit } from '../../helpers/audit.js';
import type { VerifierConfig } from '../../../src/core/contract/types.js';

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

vi.mock('../../../src/core/subagent/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/subagent/index.js')>();
  return {
    ...mod,
    runSubagent: mockRunSubagent,
  };
});

function makeConfig(overrides: Partial<VerifierConfig> = {}): VerifierConfig {
  return {
    agentId: 'verifier-test',
    clawId: 'claw-test',
    clawDir: '/tmp/claw',
    fs: {} as unknown as VerifierConfig['fs'],
    llm: {} as unknown as VerifierConfig['llm'],
    prompt: 'test prompt',
    toolRegistry: {
      getForProfile: vi.fn().mockReturnValue([]),
    } as unknown as VerifierConfig['toolRegistry'],
    ...overrides,
  };
}

describe('phase 993: verifier-job D.1 signal + D.2 catch audit emit', () => {
  beforeEach(() => {
    mockRunSubagent.mockReset();
  });

  it('signal abort → verifier early abort + VERIFIER_FAILED audit emit (kind=other)', async () => {
    const { audit, events } = makeAudit();
    const controller = new AbortController();

    // mock runSubagent to hang until aborted, then throw
    mockRunSubagent.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        const onAbort = () => reject(new Error('AbortError: signal aborted'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort);
      });
    });

    const promise = runContractVerifier(makeConfig({
      audit,
      signal: controller.signal,
    }));

    controller.abort();
    const result = await promise;

    expect(result.passed).toBe(false);

    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain('agentId=verifier-test');
    expect(failedRow).toContain('clawId=claw-test');
    expect(failedRow).toContain('kind=other');
    expect(failedRow).toContain('reason=AbortError: signal aborted');
  });

  it('ToolTimeoutError → VERIFIER_FAILED audit emit (kind=timeout)', async () => {
    const { audit, events } = makeAudit();

    mockRunSubagent.mockRejectedValue(new ToolTimeoutError('timeout', { timeoutMs: 100 }));

    const result = await runContractVerifier(makeConfig({ audit }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('超时');

    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain('agentId=verifier-test');
    expect(failedRow).toContain('clawId=claw-test');
    expect(failedRow).toContain('kind=timeout');
  });

  it('generic error → VERIFIER_FAILED audit emit (kind=other) with reason', async () => {
    const { audit, events } = makeAudit();

    mockRunSubagent.mockRejectedValue(new Error('boom'));

    const result = await runContractVerifier(makeConfig({ audit }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('boom');

    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain('agentId=verifier-test');
    expect(failedRow).toContain('clawId=claw-test');
    expect(failedRow).toContain('kind=other');
    expect(failedRow).toContain('reason=boom');
  });
});
