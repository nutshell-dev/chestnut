import { delimiter, dirname } from 'node:path';

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

/** Collapse Windows' case-insensitive Path entries without executing caller hooks twice. */
function mergeWindowsPathVariants(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  canonicalize = false,
): Readonly<Record<string, string | undefined>> {
  if (platform !== 'win32') return env;
  const entries = Object.entries(env);
  const pathEntry = entries.find(([key]) => key.toLowerCase() === 'path');
  if (pathEntry === undefined) return env;
  const merged = Object.fromEntries(
    entries.filter(([key]) => key.toLowerCase() !== 'path'),
  ) as Record<string, string | undefined>;
  merged[canonicalize ? 'Path' : pathEntry[0]] = pathEntry[1];
  return merged;
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
  const base = mergeWindowsPathVariants(baseEnv, platform);
  const host = mergeWindowsPathVariants(hostEnv, platform);
  const basePathKey = findPathKey(base, platform);
  const hostPathKey = findPathKey(host, platform);
  const pathKey = basePathKey ?? hostPathKey ?? 'PATH';
  // An explicitly supplied undefined PATH removes the host fallback as well.
  const pathEnv = (basePathKey === undefined
    ? (hostPathKey === undefined ? undefined : host[hostPathKey])
    : base[basePathKey]) ?? '';
  const augmentedPath = pathEnv.includes(nodeBinDir)
    ? pathEnv
    : pathEnv === '' ? nodeBinDir : `${nodeBinDir}${delimiter}${pathEnv}`;
  return { ...base, [pathKey]: augmentedPath };
}

/**
 * Construct a child environment from the host allowlist plus caller-authorized
 * values. Host inheritance and platform variables stay in ProcessExec; callers
 * only declare their own explicit environment contract.
 *
 * Optional host/platform arguments are test seams. Production callers leave
 * them unspecified so host facts are captured at construction time.
 */
export function createSpawnEnvironment(
  authorizedEnv: Readonly<Record<string, string | undefined>> = {},
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SpawnEnvironmentOutcome {
  try {
    // Canonicalize host Path before scrubbing so every Windows casing remains
    // subject to the same allowlist rule and only one variant survives.
    const env = scrubEnv(mergeWindowsPathVariants(hostEnv, platform, true));
    const authorized = mergeWindowsPathVariants(authorizedEnv, platform);
    for (const [key, value] of Object.entries(authorized)) {
      if (platform === 'win32' && key.toLowerCase() === 'path') {
        for (const existingKey of Object.keys(env)) {
          if (existingKey.toLowerCase() === 'path') delete env[existingKey];
        }
      }
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    // Host PATH has already been considered above. Passing an empty fallback
    // prevents an explicit PATH deletion from re-importing process.env here.
    return {
      kind: 'created',
      env: augmentNodePath(env, dirname(process.execPath), {}, platform),
    };
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
