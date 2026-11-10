import { describe, expect, expectTypeOf, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as processExec from '../../../src/foundation/process-exec/index.js';
import type { ResolvedHostScript } from '../../../src/foundation/process-exec/index.js';
import {
  ProcessExecError,
  UnsupportedHostScriptError,
} from '../../../src/foundation/process-exec/errors.js';
import {
  resolveHostScript,
  resolveHostScriptForPlatform,
} from '../../../src/foundation/process-exec/host-script.js';

const PROCESS_EXEC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/foundation/process-exec',
);

describe('ProcessExec host script resolution (phase 2066)', () => {
  it.each(['linux', 'darwin'] as const)('%s passes .sh and .SH as one sh file argument', (platform) => {
    for (const scriptPath of ['/tmp/verify contract.sh', '/tmp/验收.SH']) {
      expect(resolveHostScriptForPlatform(scriptPath, platform)).toEqual({
        executable: 'sh',
        args: [scriptPath],
      });
    }
  });

  it.each(['.cmd', '.CMD', '.bat', '.BAT'])('win32 passes %s through cmd.exe /d /s /c', (extension) => {
    const scriptPath = `C:\\contract work\\验收 & 100%!()${extension}`;
    const resolved = resolveHostScriptForPlatform(scriptPath, 'win32');

    expect(resolved).toEqual({
      executable: 'cmd.exe',
      args: ['/d', '/s', '/c', scriptPath],
    });
    expect(resolved.args).toHaveLength(4);
    expect(resolved.args.at(-1)).not.toContain('\n');
  });

  it('passes POSIX paths verbatim without -c or shebang inspection', () => {
    const scriptPath = '/tmp/a & b/$(not-a-command)/验收.sh';
    expect(resolveHostScriptForPlatform(scriptPath, 'linux').args).toEqual([scriptPath]);
  });

  it.each([
    { platform: 'win32', scriptPath: 'C:\\contract\\verify.sh', extension: '.sh', allowed: ['.cmd', '.bat'] },
    { platform: 'linux', scriptPath: '/contract/verify.cmd', extension: '.cmd', allowed: ['.sh'] },
    { platform: 'darwin', scriptPath: '/contract/verify.bat', extension: '.bat', allowed: ['.sh'] },
    { platform: 'win32', scriptPath: 'C:\\contract\\verify.ps1', extension: '.ps1', allowed: ['.cmd', '.bat'] },
    { platform: 'linux', scriptPath: '/contract/verify.ps1', extension: '.ps1', allowed: ['.sh'] },
    { platform: 'win32', scriptPath: 'C:\\contract\\verify', extension: '', allowed: ['.cmd', '.bat'] },
    { platform: 'linux', scriptPath: '/contract/verify', extension: '', allowed: ['.sh'] },
  ] as const)('rejects unsupported $platform $scriptPath with structured facts', ({
    platform,
    scriptPath,
    extension,
    allowed,
  }) => {
    let thrown: unknown;
    try {
      resolveHostScriptForPlatform(scriptPath, platform);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBeInstanceOf(UnsupportedHostScriptError);
    expect(thrown).not.toBeInstanceOf(ProcessExecError);
    const error = thrown as UnsupportedHostScriptError;
    expect(error.name).toBe('UnsupportedHostScriptError');
    expect(error.code).toBe('HOST_SCRIPT_UNSUPPORTED');
    expect(error.platform).toBe(platform);
    expect(error.scriptPath).toBe(scriptPath);
    expect(error.extension).toBe(extension);
    expect(error.allowedExtensions).toEqual(allowed);
    expect(error.message).toContain(platform);
    expect(error.message).toContain(scriptPath);
    expect(error.message).toContain(extension || '<none>');
    for (const allowedExtension of allowed) expect(error.message).toContain(allowedExtension);
  });

  it('exposes only the actual-platform resolver, result type, and typed error through the barrel', () => {
    const scriptPath = process.platform === 'win32' ? 'C:\\contract\\verify.cmd' : '/contract/verify.sh';
    const resolved: ResolvedHostScript = processExec.resolveHostScript(scriptPath);

    expect(resolved).toEqual(resolveHostScriptForPlatform(scriptPath, process.platform));
    expect(processExec.resolveHostScript).toBe(resolveHostScript);
    expect(processExec.UnsupportedHostScriptError).toBe(UnsupportedHostScriptError);
    expect(processExec).not.toHaveProperty('resolveHostScriptForPlatform');
    expect(processExec).not.toHaveProperty('execHostScript');
    expectTypeOf(processExec.resolveHostScript).toEqualTypeOf<
      (scriptPath: string) => ResolvedHostScript
    >();
    expectTypeOf(processExec.resolveHostScript).parameter(0).toEqualTypeOf<string>();
  });

  it.each(['exec.ts', 'execution-group.ts'])('keeps raw %s neutral', (file) => {
    const source = fs.readFileSync(path.join(PROCESS_EXEC_DIR, file), 'utf8');

    expect(source).not.toContain('host-script');
    expect(source).not.toContain('resolveHostScript');
    expect(source).not.toContain('UnsupportedHostScriptError');
    expect(source).not.toContain("platform === 'win32'");
  });
});
