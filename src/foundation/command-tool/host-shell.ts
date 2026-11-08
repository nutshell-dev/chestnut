/**
 * CommandTool-internal host shell resolution.
 *
 * Selects the host interpreter without inspecting or translating the command.
 * ProcessExec remains a neutral executable + args primitive.
 */
export interface ResolvedHostShell {
  readonly executable: 'sh' | 'cmd.exe';
  readonly args: string[];
  readonly invocation: 'sh -c' | 'cmd.exe /d /s /c';
}

export function resolveHostShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ResolvedHostShell {
  if (platform === 'win32') {
    return {
      executable: 'cmd.exe',
      args: ['/d', '/s', '/c', command],
      invocation: 'cmd.exe /d /s /c',
    };
  }

  return {
    executable: 'sh',
    args: ['-c', command],
    invocation: 'sh -c',
  };
}
