/**
 * verification-execution unit tests (Phase 965)
 *
 * Tests checkPathContainment realPath behavior + runScriptVerification abort propagation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import { checkPathContainment, runScriptVerification } from '../../../src/core/contract/verification-execution.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';

const mockExec = vi.fn();

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    audit: makeMockAudit() as unknown as VerificationContext['audit'],
    notifyClaw: vi.fn(),
    exec: mockExec,
    fs: { realpathSync: vi.fn((p: string) => p) } as unknown as FileSystem,
    ...overrides,
  } as VerificationContext;
}

describe('checkPathContainment (Phase 965)', () => {
  it('returns realPath instead of lexical resolved path for symlink scripts', () => {
    const fs = {
      realpathSync: vi.fn((p: string) => `/real${p}`),
    } as unknown as FileSystem;
    const result = checkPathContainment(fs, '/container', 'script.sh');
    // realPath should include the /real prefix, not the bare resolved path.
    expect(result).toBe('/real/container/script.sh');
  });

  it('returns null when realPath escapes container', () => {
    const fs = {
      realpathSync: vi.fn((p: string) => {
        if (p === '/container') return '/container';
        return '/outside/evil.sh';
      }),
    } as unknown as FileSystem;
    const result = checkPathContainment(fs, '/container', 'link.sh');
    expect(result).toBeNull();
  });
});

describe('runScriptVerification (Phase 965)', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('throws abort instead of returning passed:false when exec is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    mockExec.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const ctx = makeCtx({ signal: controller.signal });
    await expect(runScriptVerification(ctx, 'script.sh', '/tmp/contract')).rejects.toThrow('aborted');
  });

  it('still returns passed:false for non-abort ProcessExecError', async () => {
    const err = new ProcessExecError({ message: 'sh failed', output: 'bad', exitCode: 1 });
    mockExec.mockRejectedValue(err);
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, 'script.sh', '/tmp/contract');
    expect(result.passed).toBe(false);
  });
});
