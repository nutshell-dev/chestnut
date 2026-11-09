/**
 * Resolve a command for the host interpreter without inspecting or translating it.
 * ProcessExec owns the platform fact; raw exec remains an executable + args primitive.
 */
export interface ResolvedHostCommand {
  readonly executable: 'sh' | 'cmd.exe';
  readonly args: string[];
  readonly invocation: 'sh -c' | 'cmd.exe /d /s /c';
}

/** Public entry point: only the actual host platform determines the interpreter. */
export function resolveHostCommand(command: string): ResolvedHostCommand {
  return resolveHostCommandForPlatform(command, process.platform);
}

/** Module-internal test seam; deliberately not exported through the barrel. */
export function resolveHostCommandForPlatform(
  command: string,
  platform: NodeJS.Platform,
): ResolvedHostCommand {
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
