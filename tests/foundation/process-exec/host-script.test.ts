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
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';
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
      args: ['/d', '/s', '/c', `C:\\contract work\\验收 ^& 100%!^(^)` + extension],
    });
    expect(resolved.args).toHaveLength(4);
    expect(resolved.args.at(-1)).not.toContain('\n');
    expect(resolved.args.at(-1)).not.toContain('""');
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

const hostExtensions = process.platform === 'win32' ? ['.cmd', '.bat'] : ['.sh'];
const unsupportedHostExtensions = process.platform === 'win32'
  ? ['.sh', '.ps1', '']
  : ['.cmd', '.CMD', '.bat', '.BAT', '.ps1', ''];

describe(`actual ${process.platform} host script unsupported matrix`, () => {
  it.each(unsupportedHostExtensions)('rejects %s through the actual-platform public resolver', (extension) => {
    const scriptPath = path.join(process.cwd(), `unsupported contract${extension}`);
    let thrown: unknown;
    try {
      processExec.resolveHostScript(scriptPath);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedHostScriptError);
    const error = thrown as UnsupportedHostScriptError;
    expect(error.code).toBe('HOST_SCRIPT_UNSUPPORTED');
    expect(error.platform).toBe(process.platform);
    expect(error.scriptPath).toBe(scriptPath);
    expect(error.extension).toBe(extension.toLowerCase());
    expect(error.allowedExtensions).toEqual(hostExtensions);
  });
});

function writeRealScript(directory: string, extension: string, exitCode: number, marker: string): string {
  const scriptPath = path.join(directory, `verify contract${extension}`);
  const source = process.platform === 'win32'
    ? `@echo off\r\necho ${marker}\r\nexit /b ${exitCode}\r\n`
    : `#!/bin/sh\nprintf '%s\\n' '${marker}'\nexit ${exitCode}\n`;
  fs.writeFileSync(scriptPath, source, { mode: 0o644 });
  return scriptPath;
}

describe(`real ${process.platform} host script execution`, () => {
  it.each(hostExtensions)('executes %s successfully from a spaced Unicode and shell-metacharacter path', async extension => {
    const tempDir = await createTrackedTempDir('host-script-real-');
    try {
      const scriptDir = path.join(tempDir, 'contract work', '验收 & 100%!');
      fs.mkdirSync(scriptDir, { recursive: true });
      const scriptPath = writeRealScript(scriptDir, extension, 0, 'HOST_SCRIPT_SUCCESS');
      const resolved = resolveHostScript(scriptPath);

      const result = await processExec.exec(resolved.executable, resolved.args, {});

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('HOST_SCRIPT_SUCCESS');
    } finally {
      await cleanupTempDir(tempDir);
    }
  });

  it.each(hostExtensions)('preserves the complete non-zero exit and output for %s', async extension => {
    const tempDir = await createTrackedTempDir('host-script-real-');
    try {
      const scriptDir = path.join(tempDir, 'contract work', '验收 & 100%!');
      fs.mkdirSync(scriptDir, { recursive: true });
      const scriptPath = writeRealScript(scriptDir, extension, 7, 'HOST_SCRIPT_NONZERO');
      const resolved = resolveHostScript(scriptPath);

      const error = await processExec.exec(resolved.executable, resolved.args, {}).then(
        () => { throw new Error('expected non-zero script exit'); },
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ProcessExecError);
      const execError = error as ProcessExecError;
      expect(execError.exitCode).toBe(7);
      expect(execError.killed).toBe(false);
      expect(execError.output).toContain('HOST_SCRIPT_NONZERO');
    } finally {
      await cleanupTempDir(tempDir);
    }
  });
});
