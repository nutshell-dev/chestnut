import type { AtomicWriteResult } from '../../foundation/fs/index.js';
import { newUuid } from '../../foundation/node-utils/index.js';

export type CleanStopMarkerOutcome = Readonly<{
  scope: 'global' | 'claw';
  path: string;
  operationId: string;
}> & (
  | { kind: 'not_attempted' }
  | { kind: 'committed' }
  | { kind: 'failed' | 'unknown'; error: { name: string; message: string } }
);

function errorEvidence(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

/**
 * Capture the durable marker result without discarding post-rename uncertainty.
 * A platform-limited fsync still has a committed rename; unknown durability does not.
 */
export async function commitCleanStopMarker(input: {
  scope: 'global' | 'claw';
  path: string;
  write: () => AtomicWriteResult | Promise<AtomicWriteResult>;
  onThrow?: 'failed' | 'unknown';
}): Promise<CleanStopMarkerOutcome> {
  const base = {
    scope: input.scope,
    path: input.path,
    operationId: newUuid(),
  } as const;
  try {
    const result = await input.write();
    if (result.kind === 'committed_durability_unknown') {
      return { ...base, kind: 'unknown', error: errorEvidence(result.error) };
    }
    return { ...base, kind: 'committed' };
  } catch (error) {
    return {
      ...base,
      kind: input.onThrow ?? 'failed',
      error: errorEvidence(error),
    };
  }
}
