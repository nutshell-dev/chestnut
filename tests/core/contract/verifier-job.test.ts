/**
 * verifier-job unit tests (phase 990 / r121 F fork)
 *
 * Tests runContractVerifier result-parsing paths via mocked runSubagent.
 * Pure-logic cluster: capturedResult, JSON codeblock, plain JSON, parse error, timeout, generic error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import { runContractVerifier } from '../../../src/core/contract/verifier-job.js';
import { ToolTimeoutError } from '../../../src/foundation/tools/errors.js';
import type { VerifierConfig } from '../../../src/core/contract/types.js';

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

function makeConfig(overrides: Partial<VerifierConfig> = {}): VerifierConfig {
  return {
    agentId: 'verifier-test',
    clawId: 'claw-test',
    clawDir: '/tmp/claw',
    fs: {} as unknown as VerifierConfig['fs'],
    llm: {} as unknown as VerifierConfig['llm'],
    audit: makeMockAudit() as unknown as VerifierConfig['audit'],
    prompt: 'test prompt',
    toolRegistry: {
      getForProfile: vi.fn().mockReturnValue([]),
    } as unknown as VerifierConfig['toolRegistry'],
    fsFactory: vi.fn(() => ({}) as unknown as VerifierConfig['fs']),
    runSubagent: mockRunSubagent,
    ...overrides,
  };
}

describe('runContractVerifier (phase 990)', () => {
  beforeEach(() => {
    mockRunSubagent.mockReset();
  });

  it('returns structured result when capturedResult is present', async () => {
    mockRunSubagent.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok', issues: ['a'] },
    });
    const result = await runContractVerifier(makeConfig());
    expect(result.passed).toBe(true);
    expect(result.structured).toEqual({ passed: true, reason: 'ok', issues: ['a'] });
  });

  it('parses JSON codeblock when no capturedResult', async () => {
    mockRunSubagent.mockResolvedValue({
      text: '```json\n{"passed":true,"reason":"ok"}\n```',
    });
    const result = await runContractVerifier(makeConfig());
    expect(result.passed).toBe(true);
    expect(result.structured).toEqual({ passed: true, reason: 'ok' });
  });

  it('parses bare JSON when no codeblock', async () => {
    mockRunSubagent.mockResolvedValue({
      text: '{"passed":false,"reason":"nope"}',
    });
    const result = await runContractVerifier(makeConfig());
    expect(result.passed).toBe(false);
    expect(result.structured).toEqual({ passed: false, reason: 'nope' });
  });

  it('returns format error when text has no JSON', async () => {
    mockRunSubagent.mockResolvedValue({ text: 'plain text only' });
    const result = await runContractVerifier(makeConfig());
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('格式错误');
  });

  it('returns timeout feedback on ToolTimeoutError', async () => {
    mockRunSubagent.mockRejectedValue(new ToolTimeoutError('timeout', { timeoutMs: 100 }));
    const result = await runContractVerifier(makeConfig());
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('超时');
  });

  it('returns failure feedback on generic error', async () => {
    mockRunSubagent.mockRejectedValue(new Error('boom'));
    const result = await runContractVerifier(makeConfig());
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('boom');
  });

  it('rejects legacy result with non-boolean passed field', async () => {
    mockRunSubagent.mockResolvedValue({
      text: '{"passed":false,"reason":"rejected legacy shape"}',
      capturedResult: { passed: 'yes', reason: 'looks good' },
    });
    const result = await runContractVerifier(makeConfig());
    expect(result.passed).toBe(false);
    expect(result.structured).toEqual({ passed: false, reason: 'rejected legacy shape' });
  });

  it('propagates signal abort instead of returning passed:false', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mockRunSubagent.mockRejectedValue(abortError);
    const config = makeConfig({ signal: AbortSignal.abort() });
    await expect(runContractVerifier(config)).rejects.toThrow('Aborted');
  });
});
