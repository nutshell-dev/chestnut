import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeLegacyClaim } from '../../../src/foundation/messaging/claim-process-observation.js';
import * as processExec from '../../../src/foundation/process-exec/index.js';
import type {
  ProcessEvidence,
  ProcessRef,
  ProcessRefDecode,
  ProcessRefObservation,
} from '../../../src/foundation/process-exec/index.js';

vi.mock(import('../../../src/foundation/process-exec/index.js'), async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return { ...actual, decodeProcessRef: vi.fn(), inspectProcessRef: vi.fn() };
});

const EVIDENCE: ProcessEvidence = {
  version: 1,
  atMs: 123,
  facts: [{ operation: 'inspect', outcome: 'start', compatibility: 'legacy-v0' }],
};

const DECODED: ProcessRefDecode = {
  kind: 'decoded',
  value: 'legacy-reference' as ProcessRef,
};

const OBSERVED: ProcessRefObservation = {
  kind: 'unknown',
  reason: 'identity_unverifiable',
  evidence: EVIDENCE,
};

beforeEach(() => {
  vi.mocked(processExec.decodeProcessRef).mockReset();
  vi.mocked(processExec.inspectProcessRef).mockReset();
});

describe('legacy claim process observation', () => {
  it.each([
    ['with a start time', 'legacy opaque start', { version: 0, pid: 42, startTime: 'legacy opaque start' }],
    ['without a start time', undefined, { version: 0, pid: 42 }],
  ])('passes the complete v0 reference and L1 results through %s', (
    _label,
    startTime,
    expectedReference,
  ) => {
    const decode = vi.mocked(processExec.decodeProcessRef).mockReturnValue(DECODED);
    const inspect = vi.mocked(processExec.inspectProcessRef).mockReturnValue(OBSERVED);

    const facts = observeLegacyClaim(42, startTime);

    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith(expectedReference);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith('legacy-reference');
    expect(facts.decoded).toBe(DECODED);
    expect(facts.observed).toBe(OBSERVED);
    expect(facts).toEqual({ decoded: DECODED, observed: OBSERVED });
  });

  it('returns complete invalid decode evidence without inspecting the process', () => {
    const decoded: ProcessRefDecode = {
      kind: 'invalid',
      reason: 'invalid_v0_shape_or_pid',
      evidence: EVIDENCE,
    };
    vi.mocked(processExec.decodeProcessRef).mockReturnValue(decoded);
    const inspect = vi.mocked(processExec.inspectProcessRef);

    expect(observeLegacyClaim(0)).toEqual({ decoded });
    expect(inspect).not.toHaveBeenCalled();
  });
});
