import type { llmProviderModelMeasurement } from '../llm-provider/index.js';
type InputMeasurementObservation = llmProviderModelMeasurement.InputMeasurementObservation;

export type InputMeasurementRequestStatus = 'open' | 'completed' | 'failed' | 'orphan_terminal' | 'corrupt';

export interface InputMeasurementRequestState {
  readonly prepared?: InputMeasurementObservation;
  readonly terminal?: InputMeasurementObservation;
  readonly status: InputMeasurementRequestStatus;
}

export interface InputMeasurementReplayDiagnostic {
  readonly code: string;
  readonly requestKey: string;
  readonly detail: string;
}

export interface InputMeasurementReplayState {
  readonly schemaVersion: 1;
  readonly requests: ReadonlyMap<string, InputMeasurementRequestState>;
  readonly diagnostics: readonly InputMeasurementReplayDiagnostic[];
}

/** Pure append-only replay. It restores request evidence, never orchestration winners. */
export class InputMeasurementLedger {
  static replay(events: Iterable<unknown>): InputMeasurementReplayState {
    return replayEvents(events, []);
  }

  /** NDJSON reload boundary: malformed/truncated records remain explicit diagnostics. */
  static replayJsonl(jsonl: string): InputMeasurementReplayState {
    const events: unknown[] = [];
    const diagnostics: InputMeasurementReplayDiagnostic[] = [];
    const lines = jsonl.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // silent: malformed input is exposed as an invalid_json replay diagnostic below.
        diagnostics.push({
          code: 'invalid_json',
          requestKey: `line:${index + 1}`,
          detail: 'input measurement stream line is not valid JSON',
        });
      }
    }
    return replayEvents(events, diagnostics);
  }
}

function replayEvents(
  events: Iterable<unknown>,
  diagnostics: InputMeasurementReplayDiagnostic[],
): InputMeasurementReplayState {
  const requests = new Map<string, InputMeasurementRequestState>();
  try {
    for (const event of events) replayEvent(event, requests, diagnostics);
  } catch (error) {
    // silent: iteration failure is exposed as replay_failed while retaining partial evidence.
    diagnostics.push({
      code: 'replay_failed',
      requestKey: 'unknown',
      detail: error instanceof Error ? error.message : 'event iteration failed',
    });
  }
  return { schemaVersion: 1, requests, diagnostics };
}

function replayEvent(
  event: unknown,
  requests: Map<string, InputMeasurementRequestState>,
  diagnostics: InputMeasurementReplayDiagnostic[],
): void {
  if (!isRecord(event) || event.type !== 'input_measurement') return;
  const observation = isRecord(event.observation) ? event.observation : undefined;
  const requestId = typeof observation?.requestId === 'string' && observation.requestId.length > 0
    ? observation.requestId
    : undefined;
  const invocationId = stringField(event.invocationId) ?? stringField(observation?.invocationId) ?? '';
  const attemptId = stringField(event.attemptId) ?? stringField(observation?.attemptId) ?? '';
  const requestKey = JSON.stringify([invocationId, attemptId, requestId ?? 'unknown']);
  if (requestId === undefined || observation === undefined) {
    corrupt(requests, diagnostics, requestKey, 'invalid_event', 'missing observation or requestId');
    return;
  }
  if (event.schemaVersion !== undefined && event.schemaVersion !== 1) {
    corrupt(requests, diagnostics, requestKey, 'unsupported_schema', `schema=${String(event.schemaVersion)}`);
    return;
  }
  const artifactError = validateArtifactRef(observation.artifactRef);
  if (artifactError) {
    corrupt(requests, diagnostics, requestKey, artifactError.code, artifactError.detail);
    return;
  }
  if (observation.kind !== 'prepared' && observation.kind !== 'completed' && observation.kind !== 'failed') {
    corrupt(requests, diagnostics, requestKey, 'invalid_observation', `kind=${String(observation.kind)}`);
    return;
  }

  const normalized = {
    ...observation,
    requestId,
    ...(invocationId ? { invocationId } : {}),
    ...(attemptId ? { attemptId } : {}),
  } as unknown as InputMeasurementObservation;
  const existing = requests.get(requestKey);
  if (existing?.status === 'corrupt') {
    diagnose(diagnostics, 'corrupt_request', requestKey, 'ignored event after corruption');
    return;
  }

  if (normalized.kind === 'prepared') {
    if (existing?.terminal) {
      requests.set(requestKey, { ...existing, prepared: normalized, status: 'orphan_terminal' });
      diagnose(diagnostics, 'prepared_after_terminal', requestKey, 'retained orphan terminal; no fabricated transition');
    } else if (existing?.prepared) {
      diagnose(diagnostics, 'duplicate_prepared', requestKey, 'kept first prepared observation');
    } else {
      requests.set(requestKey, { prepared: normalized, status: 'open' });
    }
    return;
  }

  if (existing?.terminal) {
    diagnose(diagnostics, 'duplicate_terminal', requestKey, 'kept first terminal observation');
    return;
  }
  if (!existing?.prepared) {
    requests.set(requestKey, { ...existing, terminal: normalized, status: 'orphan_terminal' });
    diagnose(diagnostics, 'orphan_terminal', requestKey, 'terminal arrived without prepared observation');
    return;
  }
  if (!sameArtifact(existing.prepared.artifactRef, normalized.artifactRef)) {
    requests.set(requestKey, { ...existing, terminal: normalized, status: 'corrupt' });
    diagnose(diagnostics, 'artifact_mismatch', requestKey, 'prepared and terminal artifact references differ');
    return;
  }
  requests.set(requestKey, {
    prepared: existing.prepared,
    terminal: normalized,
    status: normalized.kind,
  });
}

function validateArtifactRef(ref: unknown): { code: string; detail: string } | undefined {
  if (ref === undefined) return undefined; // Legacy unlinked events remain replayable.
  if (!isRecord(ref)) return { code: 'invalid_artifact', detail: 'artifactRef is not an object' };
  if (ref.schemaVersion !== 1) return { code: 'unsupported_artifact_schema', detail: `schema=${String(ref.schemaVersion)}` };
  if (typeof ref.artifactId !== 'string' || !ref.artifactId) return { code: 'invalid_artifact', detail: 'missing artifactId' };
  if (ref.status !== 'available' && ref.status !== 'redacted' && ref.status !== 'unavailable') {
    return { code: 'invalid_artifact', detail: `status=${String(ref.status)}` };
  }
  if (ref.hashAlgorithm !== 'sha256') return { code: 'invalid_artifact', detail: 'unsupported hash algorithm' };
  if (ref.contentHash !== undefined && (typeof ref.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(ref.contentHash))) {
    return { code: 'invalid_artifact_hash', detail: 'contentHash is not lowercase sha256' };
  }
  if (ref.byteLength !== undefined
    && (typeof ref.byteLength !== 'number' || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0)) {
    return { code: 'invalid_artifact', detail: 'byteLength is not a non-negative safe integer' };
  }
  return undefined;
}

function sameArtifact(left: InputMeasurementObservation['artifactRef'], right: InputMeasurementObservation['artifactRef']): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.artifactId === right.artifactId
    && left.schemaVersion === right.schemaVersion
    && left.status === right.status
    && left.hashAlgorithm === right.hashAlgorithm
    && left.contentHash === right.contentHash
    && left.byteLength === right.byteLength
    && left.redactionPolicy === right.redactionPolicy
    && left.reason === right.reason;
}

function corrupt(
  requests: Map<string, InputMeasurementRequestState>,
  diagnostics: InputMeasurementReplayDiagnostic[],
  requestKey: string,
  code: string,
  detail: string,
): void {
  requests.set(requestKey, { ...requests.get(requestKey), status: 'corrupt' });
  diagnose(diagnostics, code, requestKey, detail);
}

function diagnose(
  diagnostics: InputMeasurementReplayDiagnostic[],
  code: string,
  requestKey: string,
  detail: string,
): void {
  diagnostics.push({ code, requestKey, detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
