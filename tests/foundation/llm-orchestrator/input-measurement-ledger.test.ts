import { describe, expect, it } from 'vitest';
import type { llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
type InputArtifactRef = llmProviderModelMeasurement.InputArtifactRef;
type InputMeasurementObservation = llmProviderModelMeasurement.InputMeasurementObservation;
import { InputMeasurementLedger } from '../../../src/foundation/llm-orchestrator/input-measurement-ledger.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function artifact(requestId: string, contentHash = HASH_A): InputArtifactRef {
  return {
    artifactId: `input-artifact-${requestId}`,
    schemaVersion: 1,
    status: 'available',
    hashAlgorithm: 'sha256',
    contentHash,
    byteLength: 42,
  };
}

function prepared(requestId: string, artifactRef?: InputArtifactRef): InputMeasurementObservation {
  return {
    kind: 'prepared',
    requestId,
    provider: 'p',
    model: 'm',
    descriptor: {
      revision: 'rev-1', provider: 'p', model: 'm', api: 'openai',
      contextWindow: 1_000, profile: 'test',
    },
    measurement: { kind: 'estimated', tokens: 3, method: 'legacy-cl100k', reason: 'test' },
    inputHash: HASH_A,
    inputSource: artifactRef?.status === 'available' ? 'artifact' : 'unlinked',
    ...(artifactRef ? { artifactRef } : {}),
  };
}

function terminal(
  requestId: string,
  kind: 'completed' | 'failed' = 'completed',
  artifactRef?: InputArtifactRef,
): InputMeasurementObservation {
  return kind === 'completed'
    ? {
        kind, requestId, provider: 'p', model: 'm', inputSource: artifactRef ? 'artifact' : 'unlinked',
        reconciliation: 'matched', inputHash: HASH_A, ...(artifactRef ? { artifactRef } : {}),
      }
    : {
        kind, requestId, provider: 'p', model: 'm', inputSource: artifactRef ? 'artifact' : 'unlinked',
        reason: 'provider_failed', inputHash: HASH_A, ...(artifactRef ? { artifactRef } : {}),
      };
}

function event(
  observation: InputMeasurementObservation,
  ids: { invocationId?: string; attemptId?: string } = { invocationId: 'inv-1', attemptId: 'att-1' },
): Record<string, unknown> {
  return {
    type: 'input_measurement',
    schemaVersion: 1,
    provider: 'p',
    model: 'm',
    ...ids,
    observation,
  };
}

function key(requestId: string, invocationId = 'inv-1', attemptId = 'att-1'): string {
  return JSON.stringify([invocationId, attemptId, requestId]);
}

describe('InputMeasurementLedger', () => {
  it('replays prepared and terminal evidence without deciding orchestration winners', () => {
    const state = InputMeasurementLedger.replay([
      event(prepared('req-1', artifact('req-1'))),
      { type: 'fallback_switched', from: 'p', to: 'q', reason: 'failed' },
      event(terminal('req-1', 'completed', artifact('req-1'))),
    ]);

    expect(state.schemaVersion).toBe(1);
    expect(state.diagnostics).toEqual([]);
    expect(state.requests.get(key('req-1'))).toMatchObject({
      status: 'completed',
      prepared: { artifactRef: { artifactId: 'input-artifact-req-1', contentHash: HASH_A } },
      terminal: { kind: 'completed' },
    });
    expect(state.requests.get(key('req-1'))).not.toHaveProperty('winner');
  });

  it('keeps retry, fallback, and hedge request identities independent', () => {
    const state = InputMeasurementLedger.replay([
      event(prepared('req-retry')),
      event(prepared('req-hedge')),
      event(terminal('req-hedge')),
      event(terminal('req-retry', 'failed')),
    ]);

    expect([...state.requests.values()].map(request => request.status)).toEqual(['failed', 'completed']);
    expect(state.requests.get(key('req-retry'))?.terminal?.requestId).toBe('req-retry');
    expect(state.requests.get(key('req-hedge'))?.terminal?.requestId).toBe('req-hedge');
  });

  it('keeps first terminals and reports duplicate and out-of-order observations', () => {
    const state = InputMeasurementLedger.replay([
      event(prepared('req-1')),
      event(terminal('req-1')),
      event(terminal('req-1')),
      event(terminal('req-1', 'failed')),
      event(terminal('req-2')),
      event(prepared('req-2')),
      event(prepared('req-3')),
      event(prepared('req-3')),
    ]);

    expect(state.requests.get(key('req-1'))).toMatchObject({ status: 'completed', terminal: { kind: 'completed' } });
    expect(state.requests.get(key('req-2'))).toMatchObject({
      status: 'orphan_terminal', prepared: { kind: 'prepared' }, terminal: { kind: 'completed' },
    });
    expect(state.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'duplicate_terminal', 'duplicate_terminal', 'orphan_terminal',
      'prepared_after_terminal', 'duplicate_prepared',
    ]);
  });

  it('accepts legacy unlinked events and produces the same state on every reload', () => {
    const events = [event(prepared('legacy')), event(terminal('legacy'))].map(item => {
      const { schemaVersion: _schemaVersion, ...legacyEvent } = item;
      return legacyEvent;
    });

    const first = InputMeasurementLedger.replay(events);
    const second = InputMeasurementLedger.replay(events);

    expect(first.requests.get(key('legacy'))?.status).toBe('completed');
    expect(first.requests.get(key('legacy'))?.prepared?.artifactRef).toBeUndefined();
    expect(second).toEqual(first);
  });

  it('preserves historical counted audit facts without rewriting their kind or method', () => {
    const historical = prepared('legacy-counted');
    if (historical.kind !== 'prepared') throw new Error('prepared fixture required');
    historical.measurement = { kind: 'counted', tokens: 12, method: 'deepseek-v41-template' };
    const state = InputMeasurementLedger.replayJsonl(
      `${JSON.stringify(event(historical))}\n${JSON.stringify(event(terminal('legacy-counted')))}`,
    );

    expect(state.diagnostics).toEqual([]);
    expect(state.requests.get(key('legacy-counted'))?.prepared).toMatchObject({
      measurement: { kind: 'counted', tokens: 12, method: 'deepseek-v41-template' },
    });
  });

  it('marks unknown schemas and malformed hashes corrupt instead of completed', () => {
    const unknownSchema = { ...event(terminal('schema')), schemaVersion: 2 };
    const badHash = event(terminal('hash', 'completed', { ...artifact('hash'), contentHash: 'bad' }));
    const badArtifactSchema = event(terminal('artifact-schema', 'completed', {
      ...artifact('artifact-schema'), schemaVersion: 2,
    } as unknown as InputArtifactRef));
    const state = InputMeasurementLedger.replay([unknownSchema, badHash, badArtifactSchema]);

    expect(state.requests.get(key('schema'))?.status).toBe('corrupt');
    expect(state.requests.get(key('hash'))?.status).toBe('corrupt');
    expect(state.requests.get(key('artifact-schema'))?.status).toBe('corrupt');
    expect(state.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'unsupported_schema', 'invalid_artifact_hash', 'unsupported_artifact_schema',
    ]);
  });

  it('leaves a request open and visible when its terminal JSONL line is truncated', () => {
    const state = InputMeasurementLedger.replayJsonl(
      `${JSON.stringify(event(prepared('truncated')))}\n{"type":"input_measurement","observation":`,
    );

    expect(state.requests.get(key('truncated'))?.status).toBe('open');
    expect(state.diagnostics).toEqual([expect.objectContaining({ code: 'invalid_json', requestKey: 'line:2' })]);
  });

  it('retains partial evidence and exposes an iterator failure', () => {
    function* broken(): Generator<unknown> {
      yield event(prepared('partial'));
      throw new Error('read failed');
    }

    const state = InputMeasurementLedger.replay(broken());

    expect(state.requests.get(key('partial'))?.status).toBe('open');
    expect(state.diagnostics).toEqual([
      { code: 'replay_failed', requestKey: 'unknown', detail: 'read failed' },
    ]);
  });

  it('rejects mismatched prepared and terminal artifact manifests', () => {
    const state = InputMeasurementLedger.replay([
      event(prepared('mismatch', artifact('mismatch', HASH_A))),
      event(terminal('mismatch', 'completed', artifact('mismatch', HASH_B))),
    ]);

    expect(state.requests.get(key('mismatch'))?.status).toBe('corrupt');
    expect(state.diagnostics).toEqual([expect.objectContaining({ code: 'artifact_mismatch' })]);
  });
});
