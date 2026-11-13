import { scrubEnv } from './env-scrub.js';
import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';

export type SpawnEnvironmentOutcome =
  | { kind: 'created'; env: Record<string, string | undefined> }
  | { kind: 'failed'; error: unknown; evidence: ProcessEvidence };

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
