import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { resolveHostShell } from '../../../src/foundation/command-tool/host-shell.js';

const COMMAND_TOOL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/foundation/command-tool',
);

describe('CommandTool host shell resolution (phase 2061)', () => {
  it.each(['linux', 'darwin'] as const)('%s uses sh -c', (platform) => {
    expect(resolveHostShell('echo hello', platform)).toEqual({
      executable: 'sh',
      args: ['-c', 'echo hello'],
      invocation: 'sh -c',
    });
  });

  it('win32 uses deterministic cmd.exe /d /s /c arguments', () => {
    expect(resolveHostShell('echo hello', 'win32')).toEqual({
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
    expect(resolveHostShell(command, 'win32').args.at(-1)).toBe(command);
    expect(resolveHostShell(command, 'linux').args.at(-1)).toBe(command);
  });

  it('both production entries consume the same resolver without a barrel export', () => {
    const execSource = fs.readFileSync(path.join(COMMAND_TOOL_DIR, 'exec.ts'), 'utf8');
    const barrelSource = fs.readFileSync(path.join(COMMAND_TOOL_DIR, 'index.ts'), 'utf8');

    expect(execSource.match(/resolveHostShell\(command\)/g)).toHaveLength(2);
    expect(execSource).not.toContain("exec('sh'");
    expect(execSource).not.toContain("execWithHandle('sh'");
    expect(barrelSource).not.toContain('host-shell');
  });
});
