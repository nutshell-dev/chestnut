/**
 * verification-execution unit tests (Phase 965)
 *
 * Tests checkPathContainment realPath behavior + runScriptVerification abort propagation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { makeMockAudit } from '../../helpers/audit.js';
import { expectedHostScriptInvocation, hostScriptFile } from '../../helpers/host-script.js';
import { checkPathContainment, runScriptVerification } from '../../../src/core/contract/verification-execution.js';
import { ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { PathGuardError } from '../../../src/foundation/fs/types.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';

const mockExec = vi.fn();
const HOST_SCRIPT = hostScriptFile('script');

function makeCtx(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    clawDir: '/tmp/claw',
    clawId: 'claw-test',
    audit: makeMockAudit() as unknown as VerificationContext['audit'],
    notifyClaw: vi.fn(),
    exec: mockExec,
    fs: { realpathSync: vi.fn((p: string) => path.resolve(p)) } as unknown as FileSystem,
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

  it('propagates EACCES instead of returning null', () => {
    const eaccesErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const fs = {
      realpathSync: vi.fn((p: string) => {
        if (p === '/container') return '/container';
        throw eaccesErr;
      }),
    } as unknown as FileSystem;
    expect(() => checkPathContainment(fs, '/container', 'script.sh')).toThrow(eaccesErr);
  });

  it('returns null when realpathSync throws PathGuardError', () => {
    const guardErr = new PathGuardError('symlink traversal', 'link.sh');
    const fs = {
      realpathSync: vi.fn((p: string) => {
        if (p === '/container') return '/container';
        throw guardErr;
      }),
    } as unknown as FileSystem;
    expect(checkPathContainment(fs, '/container', 'link.sh')).toBeNull();
  });

  it('returns null when realpathSync throws ENOENT', () => {
    const enoentErr = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const fs = {
      realpathSync: vi.fn((p: string) => {
        if (p === '/container') return '/container';
        throw enoentErr;
      }),
    } as unknown as FileSystem;
    expect(checkPathContainment(fs, '/container', 'missing.sh')).toBeNull();
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
    await expect(runScriptVerification(ctx, HOST_SCRIPT, '/tmp/contract')).rejects.toThrow('aborted');
  });

  it('still returns passed:false for non-abort ProcessExecError', async () => {
    const err = new ProcessExecError({ message: 'sh failed', output: 'bad', exitCode: 1 });
    mockExec.mockRejectedValue(err);
    const ctx = makeCtx();
    const result = await runScriptVerification(ctx, HOST_SCRIPT, '/tmp/contract');
    expect(result.passed).toBe(false);
  });

  it('resolves the current-host script after containment and before started/exec', async () => {
    mockExec.mockResolvedValue(undefined);
    const audit = makeMockAudit();
    const signal = new AbortController().signal;
    const ctx = makeCtx({ audit, signal });
    const result = await runScriptVerification(ctx, HOST_SCRIPT, '/tmp/contract');
    const resolved = path.resolve('/tmp/contract', HOST_SCRIPT);
    const invocation = expectedHostScriptInvocation(resolved);

    expect(result.passed).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      invocation.executable,
      invocation.args,
      expect.objectContaining({ cwd: ctx.clawDir, timeout: expect.any(Number), signal }),
    );
    const startedOrder = vi.mocked(audit.write).mock.invocationCallOrder[0];
    expect(startedOrder).toBeLessThan(mockExec.mock.invocationCallOrder[0]);
  });

  it('rejects .ps1 as unsupported without started audit or exec', async () => {
    const audit = makeMockAudit();
    const ctx = makeCtx({ audit });

    await expect(runScriptVerification(ctx, 'script.ps1', '/tmp/contract')).rejects.toMatchObject({
      name: 'UnsupportedHostScriptError',
      code: 'HOST_SCRIPT_UNSUPPORTED',
      scriptPath: path.resolve('/tmp/contract', 'script.ps1'),
      extension: '.ps1',
    });
    expect(mockExec).not.toHaveBeenCalled();
    expect(vi.mocked(audit.write).mock.calls.some(
      ([event]) => event === CONTRACT_AUDIT_EVENTS.VERIFICATION_SCRIPT_STARTED,
    )).toBe(false);
  });

  it('uses the realpath extension rather than a supported symlink alias', async () => {
    const audit = makeMockAudit();
    const container = path.resolve('/tmp/contract');
    const alias = path.resolve(container, 'check.sh');
    const actual = path.resolve(container, 'actual.ps1');
    const ctx = makeCtx({
      audit,
      fs: {
        realpathSync: vi.fn((candidate: string) => path.resolve(candidate) === alias ? actual : container),
      } as unknown as FileSystem,
    });

    await expect(runScriptVerification(ctx, 'check.sh', container)).rejects.toMatchObject({
      code: 'HOST_SCRIPT_UNSUPPORTED',
      scriptPath: actual,
      extension: '.ps1',
    });
    expect(mockExec).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('keeps containment rejection ahead of host support resolution', async () => {
    const audit = makeMockAudit();
    const ctx = makeCtx({ audit });
    const result = await runScriptVerification(ctx, '../outside.ps1', '/tmp/contract');

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('路径安全拒绝');
    expect(mockExec).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });
});
