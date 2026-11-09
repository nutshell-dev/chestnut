import { describe, expect, expectTypeOf, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as processExec from '../../../src/foundation/process-exec/index.js';
import type { ResolvedHostCommand } from '../../../src/foundation/process-exec/index.js';
import {
  resolveHostCommand,
  resolveHostCommandForPlatform,
} from '../../../src/foundation/process-exec/host-command.js';

const PROCESS_EXEC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/foundation/process-exec',
);

describe('ProcessExec host command resolution (phase 2062)', () => {
  it.each(['linux', 'darwin'] as const)('%s uses sh -c', (platform) => {
    expect(resolveHostCommandForPlatform('echo hello', platform)).toEqual({
      executable: 'sh',
      args: ['-c', 'echo hello'],
      invocation: 'sh -c',
    });
  });

  it('win32 uses deterministic cmd.exe /d /s /c arguments', () => {
    expect(resolveHostCommandForPlatform('echo hello', 'win32')).toEqual({
      executable: 'cmd.exe',
      args: ['/d', '/s', '/c', 'echo hello'],
      invocation: 'cmd.exe /d /s /c',
    });
  });

  it.each([
    'echo $() %VAR% | findstr value',
    'echo first\necho second',
    'powershell.exe -NoProfile -Command "Write-Output \'hello world\'"',
  ])('passes the command through verbatim: %j', (command) => {
    expect(resolveHostCommandForPlatform(command, 'win32').args.at(-1)).toBe(command);
    expect(resolveHostCommandForPlatform(command, 'linux').args.at(-1)).toBe(command);
  });

  it('exposes only the actual-platform resolver and its result type through the barrel', () => {
    const command = 'echo $HOME | cat';
    const resolved: ResolvedHostCommand = processExec.resolveHostCommand(command);

    expect(resolved).toEqual(resolveHostCommandForPlatform(command, process.platform));
    expect(processExec.resolveHostCommand).toBe(resolveHostCommand);
    expect(processExec).not.toHaveProperty('resolveHostCommandForPlatform');
    expectTypeOf(processExec.resolveHostCommand).toEqualTypeOf<
      (command: string) => ResolvedHostCommand
    >();
  });

  it.each(['exec.ts', 'execution-group.ts'])('keeps raw %s neutral', (file) => {
    const source = fs.readFileSync(path.join(PROCESS_EXEC_DIR, file), 'utf8');

    expect(source).not.toContain('host-command');
    expect(source).not.toContain('resolveHostCommand');
    expect(source).not.toContain('process.platform');
    expect(source).not.toContain("platform === 'win32'");
    expect(source).not.toContain('cmd.exe');
  });
});
