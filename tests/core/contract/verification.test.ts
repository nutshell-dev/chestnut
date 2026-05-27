/**
 * verification pure-fn cluster unit tests (phase 990 / r121 F fork)
 *
 * Tests formatRejectionFeedback (pure) + runScriptVerification path-safety & exec handling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import { formatRejectionFeedback, runScriptVerification } from '../../../src/core/contract/verification.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import type { VerificationContext } from '../../../src/core/contract/verification.js';

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}));

vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...mod,
    exec: mockExec,
  };
});

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    audit: makeMockAudit() as unknown as VerificationContext['audit'],
    ...overrides,
  } as VerificationContext;
}

describe('formatRejectionFeedback (phase 990)', () => {
  it('formats full rejection with issues', () => {
    const text = formatRejectionFeedback(
      'st-1',
      'desc A',
      'reason X',
      ['issue1', 'issue2'],
      2,
      3,
      'script',
      'check.sh',
    );
    expect(text).toContain('st-1');
    expect(text).toContain('desc A');
    expect(text).toContain('reason X');
    expect(text).toContain('- issue1');
    expect(text).toContain('- issue2');
    expect(text).toContain('2/3 次');
    expect(text).toContain('script (check.sh)');
  });

  it('formats rejection without issues', () => {
    const text = formatRejectionFeedback(
      'st-2',
      'desc B',
      'reason Y',
      [],
      1,
      5,
      'llm',
      'prompt.md',
    );
    expect(text).toContain('(未提供具体问题)');
    expect(text).toContain('llm (prompt.md)');
  });
});

describe('runScriptVerification (phase 990)', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('rejects path escape attempt', async () => {
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, '../escape.sh', '/tmp/contract');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('路径安全拒绝');
  });

  it('returns passed when script exits 0', async () => {
    mockExec.mockResolvedValue(undefined);
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, 'check.sh', '/tmp/contract');
    expect(result.passed).toBe(true);
    expect(result.feedback).toContain('passed');
  });

  it('returns failed with first line on ProcessExecError', async () => {
    const err = new ProcessExecError({ message: 'sh failed', output: 'first bad line\nsecond line', exitCode: 1 });
    mockExec.mockRejectedValue(err);
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, 'check.sh', '/tmp/contract');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('first bad line');
  });

  it('returns timeout feedback when killed', async () => {
    const err = new ProcessExecError({ message: 'timeout', output: 'took too long', exitCode: null, killed: true });
    mockExec.mockRejectedValue(err);
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, 'check.sh', '/tmp/contract');
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('超时');
  });
});
