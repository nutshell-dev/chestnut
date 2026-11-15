import { extname } from 'path';

import { UnsupportedHostScriptError } from './errors.js';
import type { ResolvedHostCommand } from './host-command.js';

/** A script file resolved to the host interpreter and its file argument. */
export type ResolvedHostScript = Pick<ResolvedHostCommand, 'executable' | 'args'>;

/**
 * Encode a script path for the command string consumed by `cmd /c`.
 *
 * Node/libuv adds its own outer quotes when the argument contains spaces. The
 * `/s` form of `cmd /c` removes those outer quotes before parsing the command,
 * so shell metacharacters must be escaped in the command string itself. Keep
 * this encoding local to the host-script resolver; raw ProcessExec remains
 * argument based and platform neutral.
 */
function encodeWindowsScriptPath(scriptPath: string): string {
  return scriptPath.replace(/[&()<>|^]/g, '^$&');
}

/** Public entry point: only the actual host platform determines script support. */
export function resolveHostScript(scriptPath: string): ResolvedHostScript {
  return resolveHostScriptForPlatform(scriptPath, process.platform);
}

/** Module-internal test seam; deliberately not exported through the barrel. */
export function resolveHostScriptForPlatform(
  scriptPath: string,
  platform: NodeJS.Platform,
): ResolvedHostScript {
  const extension = extname(scriptPath).toLowerCase();
  const allowedExtensions = platform === 'win32' ? ['.cmd', '.bat'] : ['.sh'];

  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    return {
      executable: 'cmd.exe',
      args: ['/d', '/s', '/c', encodeWindowsScriptPath(scriptPath)],
    };
  }
  if (platform !== 'win32' && extension === '.sh') {
    return { executable: 'sh', args: [scriptPath] };
  }

  throw new UnsupportedHostScriptError({
    platform,
    scriptPath,
    extension,
    allowedExtensions,
  });
}
