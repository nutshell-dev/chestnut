import {
  captureOwnedProcessRef,
  decodeProcessRef,
  inspectProcessRef as inspectL1ProcessRef,
  terminateProcessRef as terminateL1ProcessRef,
  type ProcessRef,
  type ProcessRefCapture,
  type ProcessRefDecode,
  type ProcessRefObservation,
  type ProcessTerminationOptions,
  type ProcessTerminationOutcome,
} from '../process-exec/index.js';
import type { ProcessPidRecord } from './types.js';
import type { ProcessManagerContext } from './types.js';

export type PersistentProcessFact = Pick<
  ProcessPidRecord,
  'pid' | 'start_time' | 'process_ref'
>;

/** The only PM-side persistent identity decode, including the legacy v0 adapter. */
export function decodeProcessFact(record: PersistentProcessFact): ProcessRefDecode {
  return decodeProcessRef(record.process_ref ?? {
    version: 0,
    pid: record.pid,
    ...(record.start_time !== undefined ? { startTime: record.start_time } : {}),
  });
}

function decodedFailure(decoded: Exclude<ProcessRefDecode, { kind: 'decoded' }>): ProcessRefObservation {
  return {
    kind: 'unknown',
    reason: decoded.kind === 'unsupported_version' ? 'unsupported' : 'identity_unverifiable',
    evidence: decoded.evidence,
  };
}

export function inspectProcessRefValue(
  ctx: ProcessManagerContext,
  ref: ProcessRef,
): ProcessRefObservation {
  const decoded = decodeProcessRef(ref);
  if (decoded.kind !== 'decoded') return decodedFailure(decoded);
  return (ctx.inspectProcessRef ?? inspectL1ProcessRef)(decoded.value);
}

/** Decode and inspect one persistent fact without exposing its JSON internals. */
export function observeProcessFact(
  ctx: ProcessManagerContext,
  record: PersistentProcessFact,
): ProcessRefObservation {
  const decoded = decodeProcessFact(record);
  if (decoded.kind !== 'decoded') return decodedFailure(decoded);
  return (ctx.inspectProcessRef ?? inspectL1ProcessRef)(decoded.value);
}

export function captureProcessFactRef(
  ctx: ProcessManagerContext,
  pid: number,
): ProcessRefCapture {
  return (ctx.captureProcessRef ?? captureOwnedProcessRef)(pid);
}

/** PM supplies timing policy; L1 owns identity checks, signals and settle evidence. */
export function terminateProcessFact(
  ctx: ProcessManagerContext,
  record: PersistentProcessFact,
  options: ProcessTerminationOptions,
): Promise<ProcessTerminationOutcome> {
  const decoded = decodeProcessFact(record);
  if (decoded.kind !== 'decoded') {
    return Promise.resolve({
      kind: 'indeterminate',
      stage: 'observe',
      error: decoded,
      termSent: false,
      killSent: false,
      evidence: decoded.evidence,
    });
  }
  if (ctx.terminateProcessRef !== undefined) {
    return ctx.terminateProcessRef(decoded.value, options);
  }
  return terminateL1ProcessRef(decoded.value, options, {
    signal: ctx.kill,
    inspect: ctx.inspectProcessRef,
  });
}
