/**
 * Versioned execution identity capture, persistence decoding, observation and
 * termination. AsyncTaskSystem persists these values opaquely; all OS identity
 * rules and evidence stay in ProcessExec.
 */
import {
  isValidV1ExecutionIdentity,
  probeExecutionGroupDetailed,
  terminateExecutionGroup,
  type GroupTerminationOptions,
} from './execution-group.js';
import { encodeProcessEvidence, type ProcessEvidence } from './process-evidence.js';
import { observeProcess } from './process-observation.js';
import type { ProcessUnavailableReason } from './process-reference.js';
import type {
  ExecutionIdentity,
  ExecutionTerminationOutcome,
  ExecutionTerminationTrigger,
} from './types.js';

export interface ExecutionGroupTarget extends ExecutionIdentity {
  version: 1;
  leaderStartTime?: string;
}

/** In-memory representation of legacy migratedPid/migratedStartTime records. */
export interface LegacyExecutionTarget {
  version: 0;
  leaderPid: number;
  leaderStartTime?: string;
}

export type ExecutionTarget = ExecutionGroupTarget | LegacyExecutionTarget;

export type ExecutionTargetCapture =
  | { kind: 'captured'; target: ExecutionGroupTarget; evidence: ProcessEvidence }
  | { kind: 'gone'; target: ExecutionGroupTarget; evidence: ProcessEvidence }
  | { kind: 'unknown'; target: ExecutionGroupTarget; reason: string; evidence: ProcessEvidence; error?: unknown }
  | { kind: 'invalid'; reason: string; evidence: ProcessEvidence };

export type ExecutionTargetDecode =
  | { kind: 'decoded'; target: ExecutionTarget; evidence: ProcessEvidence }
  | { kind: 'invalid'; reason: string; evidence: ProcessEvidence }
  | { kind: 'unsupported_version'; reason: string; evidence: ProcessEvidence };

export type ExecutionTargetObservation =
  | { kind: 'alive'; target: ExecutionTarget; evidence: ProcessEvidence }
  | {
      kind: 'gone'; target: ExecutionTarget; reason: 'absent' | 'identity_changed';
      observedStartTime?: string; evidence: ProcessEvidence;
    }
  | {
      kind: 'unknown'; target: ExecutionTarget; reason: string;
      evidence: ProcessEvidence; error?: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1;
}

function decodeFailure(
  kind: 'invalid' | 'unsupported_version',
  reason: string,
  raw: unknown,
  legacyPid?: unknown,
  legacyStartTime?: unknown,
): ExecutionTargetDecode {
  return {
    kind, reason,
    evidence: encodeProcessEvidence(Date.now(), [{
      operation: 'decode_execution_target', outcome: kind, reason,
      migratedExecution: raw, migratedPid: legacyPid, migratedStartTime: legacyStartTime,
    }]),
  };
}

/** Decode current v1 or legacy PID-only persistence without consulting the OS. */
export function decodeExecutionTarget(
  raw: unknown,
  legacyPid?: unknown,
  legacyStartTime?: unknown,
): ExecutionTargetDecode {
  if (raw !== undefined && legacyPid !== undefined) {
    return decodeFailure('invalid', 'conflicting_execution_identities', raw, legacyPid, legacyStartTime);
  }
  if (raw === undefined) {
    if (!validPid(legacyPid)) {
      return decodeFailure('invalid', legacyPid === undefined
        ? 'missing_execution_identity' : 'invalid_legacy_execution_identity', raw, legacyPid, legacyStartTime);
    }
    if (legacyStartTime !== undefined && typeof legacyStartTime !== 'string') {
      return decodeFailure('invalid', 'invalid_legacy_start_time', raw, legacyPid, legacyStartTime);
    }
    const target: LegacyExecutionTarget = {
      version: 0,
      leaderPid: legacyPid,
      ...(typeof legacyStartTime === 'string' ? { leaderStartTime: legacyStartTime } : {}),
    };
    return {
      kind: 'decoded', target,
      evidence: encodeProcessEvidence(Date.now(), [{
        operation: 'decode_execution_target', outcome: 'decoded', compatibility: 'legacy_pid_only', target,
      }]),
    };
  }
  if (!isRecord(raw)) return decodeFailure('invalid', 'invalid_execution_identity', raw);
  if (typeof raw.version === 'number' && Number.isSafeInteger(raw.version) && raw.version > 1) {
    return decodeFailure('unsupported_version', 'unsupported_execution_identity_version', raw);
  }
  if (raw.version !== 1 || !hasOnlyKeys(raw, [
    'version', 'leaderPid', 'processGroupId', 'leaderStartTime',
  ]) || !validPid(raw.leaderPid) || !validPid(raw.processGroupId)
      || (raw.leaderStartTime !== undefined && typeof raw.leaderStartTime !== 'string')) {
    return decodeFailure('invalid', 'invalid_execution_identity', raw);
  }
  const identity = { leaderPid: raw.leaderPid, processGroupId: raw.processGroupId };
  if (!isValidV1ExecutionIdentity(identity)) {
    return decodeFailure('invalid', 'invalid_execution_identity', raw);
  }
  const target: ExecutionGroupTarget = {
    version: 1,
    ...identity,
    ...(typeof raw.leaderStartTime === 'string' ? { leaderStartTime: raw.leaderStartTime } : {}),
  };
  return {
    kind: 'decoded', target,
    evidence: encodeProcessEvidence(Date.now(), [{
      operation: 'decode_execution_target', outcome: 'decoded', compatibility: 'v1', target,
    }]),
  };
}

/** Capture a newly spawned group; an unreadable start time never invents one. */
export function captureExecutionTarget(identity: ExecutionIdentity): ExecutionTargetCapture {
  const atMs = Date.now();
  const facts: unknown[] = [{ operation: 'capture_execution_target', outcome: 'start', identity }];
  const target: ExecutionGroupTarget = { version: 1, ...identity };
  if (!isValidV1ExecutionIdentity(identity)) {
    return {
      kind: 'invalid', reason: 'invalid_execution_identity',
      evidence: encodeProcessEvidence(atMs, facts),
    };
  }
  const observation = observeProcess(identity.leaderPid);
  facts.push({ operation: 'observe_leader', outcome: observation });
  if (observation.kind === 'alive') {
    target.leaderStartTime = observation.startTime;
    return { kind: 'captured', target, evidence: encodeProcessEvidence(atMs, facts) };
  }
  if (observation.kind === 'gone') {
    return { kind: 'gone', target, evidence: encodeProcessEvidence(atMs, facts) };
  }
  const reason: ProcessUnavailableReason = observation.reason === 'unsupported_platform'
    ? 'unsupported'
    : observation.reason === 'invalid_pid' || observation.reason === 'malformed_start_time'
      ? 'incomplete_data'
      : 'query_failed';
  return {
    kind: 'unknown', target, reason,
    evidence: encodeProcessEvidence(atMs, facts),
  };
}

/** Observe identity without exposing ps output or start-time comparison to ATS. */
export function observeExecutionTarget(target: ExecutionTarget): ExecutionTargetObservation {
  if (target.version === 1) {
    const detail = probeExecutionGroupDetailed(target, target.leaderStartTime);
    if (detail.state.kind === 'verified_alive') {
      return { kind: 'alive', target, evidence: detail.evidence };
    }
    if (detail.state.kind === 'gone') {
      return { kind: 'gone', target, reason: 'absent', evidence: detail.evidence };
    }
    return {
      kind: 'unknown', target, reason: detail.state.reason, evidence: detail.evidence,
      ...(detail.error !== undefined ? { error: detail.error } : {}),
    };
  }

  const atMs = Date.now();
  const observation = observeProcess(target.leaderPid);
  const evidence = encodeProcessEvidence(atMs, [{
    operation: 'observe_legacy_execution_target', outcome: observation, target,
  }]);
  if (observation.kind === 'gone') {
    return { kind: 'gone', target, reason: 'absent', evidence };
  }
  if (observation.kind === 'unknown') {
    return { kind: 'unknown', target, reason: observation.reason, evidence };
  }
  if (target.leaderStartTime === undefined) {
    return { kind: 'unknown', target, reason: 'leader_start_time_unavailable', evidence };
  }
  if (observation.startTime !== target.leaderStartTime) {
    return {
      kind: 'gone', target, reason: 'identity_changed',
      observedStartTime: observation.startTime, evidence,
    };
  }
  return { kind: 'alive', target, evidence };
}

/** Terminate only a verified v1 group target; legacy PID-only records are read-only. */
export function terminateExecutionTarget(
  target: ExecutionGroupTarget,
  trigger: ExecutionTerminationTrigger,
  options?: GroupTerminationOptions,
): Promise<ExecutionTerminationOutcome> {
  return terminateExecutionGroup(target, trigger, options);
}
