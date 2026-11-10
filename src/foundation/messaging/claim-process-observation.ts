import { decodeProcessRef, inspectProcessRef } from '../process-exec/index.js';
import type { ProcessRefDecode, ProcessRefObservation } from '../process-exec/index.js';

export type ClaimProcessFacts = {
  decoded: ProcessRefDecode;
  observed?: ProcessRefObservation;
};

/** Adapt a legacy claim to the L1 decoder/observer without making a recovery decision. */
export function observeLegacyClaim(pid: number, startTime?: string): ClaimProcessFacts {
  const decoded = decodeProcessRef({
    version: 0,
    pid,
    ...(startTime !== undefined && { startTime }),
  });
  return decoded.kind === 'decoded'
    ? { decoded, observed: inspectProcessRef(decoded.value) }
    : { decoded };
}
