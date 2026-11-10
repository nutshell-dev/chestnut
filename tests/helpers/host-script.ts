/** Current-host script fixtures for ContractSystem execution tests. */
export function hostScriptFile(stem = 'check'): string {
  return `${stem}${process.platform === 'win32' ? '.cmd' : '.sh'}`;
}

export function hostScriptSource(exitCode: number): string {
  return process.platform === 'win32'
    ? `@echo off\r\nexit /b ${exitCode}\r\n`
    : `#!/bin/sh\nexit ${exitCode}\n`;
}

/** Independent expected invocation; do not replace this with the resolver under test. */
export function expectedHostScriptInvocation(scriptPath: string): {
  executable: 'sh' | 'cmd.exe';
  args: string[];
} {
  return process.platform === 'win32'
    ? { executable: 'cmd.exe', args: ['/d', '/s', '/c', scriptPath] }
    : { executable: 'sh', args: [scriptPath] };
}
