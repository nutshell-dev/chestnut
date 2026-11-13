import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runScriptVerification } from '../../../src/core/contract/verification-execution.js';
import type { VerificationContext } from '../../../src/core/contract/verification-types.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { UnsupportedHostScriptError } from '../../../src/foundation/process-exec/index.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

let tempDir: string;
let contractDir: string;

beforeEach(async () => {
  tempDir = await createTrackedTempDir('contract-host-script-');
  contractDir = path.join(tempDir, 'contract work', '验收 & 100%!');
  fs.mkdirSync(contractDir, { recursive: true });
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    clawDir: contractDir,
    clawId: 'claw-host-script',
    audit: makeMockAudit() as unknown as VerificationContext['audit'],
    notifyClaw: vi.fn(),
    fs: new NodeFileSystem({ baseDir: tempDir }),
    ...overrides,
  } as VerificationContext;
}

function writeScript(exitCode: number, marker: string): string {
  const fileName = `verify contract${process.platform === 'win32' ? '.cmd' : '.sh'}`;
  const source = process.platform === 'win32'
    ? `@echo off\r\necho ${marker}\r\nexit /b ${exitCode}\r\n`
    : `#!/bin/sh\nprintf '%s\\n' '${marker}'\nexit ${exitCode}\n`;
  fs.writeFileSync(path.join(contractDir, fileName), source, { mode: 0o644 });
  return fileName;
}

describe('ContractSystem real host script execution', () => {
  it('passes a real script through containment and the host resolver', async () => {
    const script = writeScript(0, 'CONTRACT_HOST_SUCCESS');
    const result = await runScriptVerification(makeContext(), script, contractDir);
    expect(result.passed).toBe(true);
  });

  it('returns verifier failure with output for a real non-zero script', async () => {
    const script = writeScript(7, 'CONTRACT_HOST_NONZERO');
    const result = await runScriptVerification(makeContext(), script, contractDir);
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('CONTRACT_HOST_NONZERO');
  });

  it('rejects a real unsupported file before started audit or spawn', async () => {
    const scriptPath = path.join(contractDir, 'verify.ps1');
    fs.writeFileSync(scriptPath, 'Write-Output should-not-run\n');
    const audit = makeMockAudit();
    const exec = vi.fn();
    const ctx = makeContext({ audit, exec });

    await expect(runScriptVerification(ctx, 'verify.ps1', contractDir)).rejects.toMatchObject({
      name: 'UnsupportedHostScriptError',
      code: 'HOST_SCRIPT_UNSUPPORTED',
      platform: process.platform,
      scriptPath: fs.realpathSync(scriptPath),
      extension: '.ps1',
    } satisfies Partial<UnsupportedHostScriptError>);
    expect(exec).not.toHaveBeenCalled();
    expect(vi.mocked(audit.write).mock.calls.some(
      ([event]) => event === CONTRACT_AUDIT_EVENTS.VERIFICATION_SCRIPT_STARTED,
    )).toBe(false);
  });
});
