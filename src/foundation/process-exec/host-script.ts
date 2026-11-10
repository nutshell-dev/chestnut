import { extname } from 'path';

import { UnsupportedHostScriptError } from './errors.js';
import type { ResolvedHostCommand } from './host-command.js';

/** A script file resolved to the host interpreter and its file argument. */
export type ResolvedHostScript = Pick<ResolvedHostCommand, 'executable' | 'args'>;

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
    return { executable: 'cmd.exe', args: ['/d', '/s', '/c', scriptPath] };
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
