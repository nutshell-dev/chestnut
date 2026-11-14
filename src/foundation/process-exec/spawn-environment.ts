import { delimiter } from 'node:path';

import { scrubEnv } from './env-scrub.js';
import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';

export type SpawnEnvironmentOutcome =
  | { kind: 'created'; env: Record<string, string | undefined> }
  | { kind: 'failed'; error: unknown; evidence: ProcessEvidence };

function findPathKey(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return Object.hasOwn(env, 'PATH') ? 'PATH' : undefined;
  return Object.keys(env).find(key => key.toLowerCase() === 'path');
}

/**
 * Add the current Node bin directory without changing the caller's env contract.
 * Windows env keys are case-insensitive, so an authorized/host `Path` entry is
 * augmented in place instead of creating a second, ineffective `PATH` entry.
 * The platform/host arguments are module-internal test seams, like the host
 * argument to createSpawnEnvironment below.
 */
export function augmentNodePath(
  baseEnv: Readonly<Record<string, string | undefined>>,
  nodeBinDir: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
  const basePathKey = findPathKey(baseEnv, platform);
  const hostPathKey = findPathKey(hostEnv, platform);
  const pathKey = basePathKey ?? hostPathKey ?? 'PATH';
  const pathEnv = (basePathKey === undefined ? undefined : baseEnv[basePathKey])
    ?? (hostPathKey === undefined ? undefined : hostEnv[hostPathKey])
    ?? '';
  const augmentedPath = pathEnv.includes(nodeBinDir)
    ? pathEnv
    : `${nodeBinDir}${delimiter}${pathEnv}`;
  return { ...baseEnv, [pathKey]: augmentedPath };
}

/**
 * Construct a child environment from the host allowlist plus caller-authorized
 * values. Host inheritance and platform variables stay in ProcessExec; callers
 * only declare their own explicit environment contract.
 *
 * The optional host argument is a test seam. Production callers must leave it
 * unspecified so the current host environment is captured at construction time.
 */
export function createSpawnEnvironment(
  authorizedEnv: Readonly<Record<string, string | undefined>> = {},
  hostEnv: NodeJS.ProcessEnv = process.env,
): SpawnEnvironmentOutcome {
  try {
    const env = scrubEnv(hostEnv);
    for (const [key, value] of Object.entries(authorizedEnv)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return { kind: 'created', env };
  } catch (error) {
    return {
      kind: 'failed',
      error,
      evidence: encodeProcessEvidence(Date.now(), [{
        operation: 'create_spawn_environment', outcome: 'throw', error,
      }]),
    };
  }
}
