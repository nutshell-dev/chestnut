/**
 * Narrow bridge from a decoded persistent identity to L1 termination.
 *
 * Callers never unwrap pid/startTime/source. Every settle observation goes back
 * through inspectProcessRef, so legacy v0 presence stays unknown and cannot
 * authorize a signal through the generic ProcessTarget compatibility path.
 */
import {
  decodeProcessRef,
  inspectProcessRef as inspectL1ProcessRef,
  processTargetFromRef,
  type ProcessRef,
  type ProcessRefObservation,
} from './process-reference.js';
import {
  terminateProcessTarget,
  type ProcessTargetObservation,
  type ProcessTerminationOptions,
  type ProcessTerminationOutcome,
} from './process-target.js';
import { kill } from './process-control.js';

export interface ProcessRefTerminationAdapters {
  inspect?: (ref: ProcessRef) => ProcessRefObservation;
  signal?: (pid: number, signal: 'TERM' | 'KILL') => void;
}

function targetObservation(observation: ProcessRefObservation): ProcessTargetObservation {
  if (observation.kind === 'alive') return { kind: 'alive', evidence: observation.evidence };
  if (observation.kind === 'gone') {
    return { kind: 'gone', reason: observation.reason, evidence: observation.evidence };
  }
  return { kind: 'unknown', reason: observation.reason, evidence: observation.evidence };
}

/** Terminate only an identity that inspect proves alive; unknown never signals. */
export async function terminateProcessRef(
  ref: ProcessRef,
  options: ProcessTerminationOptions = {},
  adapters: ProcessRefTerminationAdapters = {},
): Promise<ProcessTerminationOutcome> {
  const decoded = decodeProcessRef(ref);
  const target = decoded.kind === 'decoded' ? processTargetFromRef(decoded.value) : undefined;
  if (decoded.kind !== 'decoded' || target === undefined) {
    const evidence = decoded.kind === 'decoded'
      ? { version: 1 as const, atMs: Date.now(), facts: [] }
      : decoded.evidence;
    return {
      kind: 'indeterminate',
      stage: 'observe',
      error: decoded,
      termSent: false,
      killSent: false,
      evidence,
    };
  }
  const inspect = adapters.inspect ?? inspectL1ProcessRef;
  return terminateProcessTarget(target, options, {
    signal: adapters.signal ?? kill,
    observeTarget: () => targetObservation(inspect(decoded.value)),
  });
}
