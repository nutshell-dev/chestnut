/**
 * Test-only adapter from historical boolean probes to typed ProcessRef facts.
 * Production code must use decodeProcessRef/inspectProcessRef directly.
 */
import {
  decodeProcessRef,
  processTargetFromRef,
  type ProcessRef,
  type ProcessRefObservation,
} from '../../src/foundation/process-exec/process-reference.js';
import { encodeProcessEvidence } from '../../src/foundation/process-exec/process-evidence.js';
import type { ProcessStartTime } from '../../src/foundation/process-exec/process-starttime.js';
import type { ProcessRefCapture } from '../../src/foundation/process-exec/process-reference.js';
import { hostname } from 'node:os';

export function makeProcessRefCaptureForTest(
  pid: number,
  startTime?: ProcessStartTime,
): Extract<ProcessRefCapture, { kind: 'captured' }> {
  const internal = startTime === undefined
    ? { version: 0, pid }
    : {
        version: 1,
        pid,
        startTime,
        source: {
          platform: process.platform,
          hostname: hostname(),
          tzEnv: process.env.TZ ?? null,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        basis: 'posix-lstart-second',
        capturedAtMs: Date.now(),
      };
  const value = JSON.stringify(internal) as ProcessRef;
  return {
    kind: 'captured',
    value,
    target: { pid, ...(startTime !== undefined ? { startTime } : {}) },
    evidence: evidence('test_capture', internal),
  };
}

interface LegacyInspectionContext {
  inspectProcessRef?: (ref: ProcessRef) => ProcessRefObservation;
  l1IsAlive?: (pid: number, startTime?: ProcessStartTime) => boolean;
}

function evidence(operation: string, detail: unknown) {
  return encodeProcessEvidence(Date.now(), [{ operation, outcome: detail }]);
}

const LEGACY_INSPECTOR = Symbol('legacyProcessRefInspector');

/** Install the test adapter, replacing an earlier adapter after a probe override. */
export function installLegacyProcessRefInspector<T extends LegacyInspectionContext>(ctx: T): T {
  if (ctx.inspectProcessRef !== undefined
      && (ctx.inspectProcessRef as unknown as Record<symbol, unknown>)[LEGACY_INSPECTOR] !== true) {
    return ctx;
  }
  const inspector = (ref: ProcessRef): ProcessRefObservation => {
    const decoded = decodeProcessRef(ref);
    if (decoded.kind !== 'decoded') {
      return {
        kind: 'unknown',
        reason: decoded.kind === 'unsupported_version' ? 'unsupported' : 'identity_unverifiable',
        evidence: decoded.evidence,
      };
    }
    const target = processTargetFromRef(decoded.value);
    if (target === undefined) {
      return {
        kind: 'unknown', reason: 'identity_unverifiable',
        evidence: evidence('test_decode', 'target_unavailable'),
      };
    }
    // Test-only legacy projection. Production never parses the opaque ref.
    const legacy = JSON.parse(decoded.value) as { startTime?: ProcessStartTime };
    try {
      const alive = ctx.l1IsAlive?.(target.pid, legacy.startTime) ?? true;
      return alive
        ? { kind: 'alive', evidence: evidence('test_probe', 'alive') }
        : { kind: 'gone', reason: 'absent', evidence: evidence('test_probe', 'gone') };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return { kind: 'gone', reason: 'absent', evidence: evidence('test_probe', error) };
      }
      return {
        kind: 'unknown',
        reason: code === 'EPERM' || code === 'EACCES' ? 'permission_denied'
          : code === 'ETIMEDOUT' ? 'timed_out' : 'query_failed',
        error,
        evidence: evidence('test_probe', error),
      };
    }
  };
  Object.defineProperty(inspector, LEGACY_INSPECTOR, { value: true });
  ctx.inspectProcessRef = inspector;
  return ctx;
}
