import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

/** Return the host user's home directory without workspace fallbacks. */
export function getHostHomeDirectory(): string {
  const home = homedir();
  if (!home || !isAbsolute(home)) {
    throw new Error('Host home directory is unavailable');
  }
  return home;
}
