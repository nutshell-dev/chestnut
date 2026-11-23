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

function withoutSchemaVersion(item: Record<string, unknown>): Record<string, unknown> {
  const { schemaVersion: _schemaVersion, ...legacyEvent } = item;
  return legacyEvent;
}

function historicalPrepared(requestId: string, tokens: number): InputMeasurementObservation {
  return {
    kind: 'prepared', requestId, provider: 'p', model: 'm',
    descriptor: {
      revision: 'historical-rev', provider: 'p', model: 'm',
      api: 'anthropic-messages', contextWindow: 1_000_000,
      profile: 'deepseek-v41-flash-1017-v1',
    },
    measurement: { kind: 'counted', tokens, method: 'deepseek-v41-template' },
    inputHash: HASH_A, inputSource: 'unlinked',
  };
}

function historicalCompleted(
  requestId: string,
  localTokens: number,
  supplierTokens: number,
  deltaTokens: number,
  reconciliation: 'matched' | 'mismatch',
  reason?: string,
): InputMeasurementObservation {
  return {
    kind: 'completed', requestId, provider: 'p', model: 'm',
    descriptorRevision: 'historical-rev', inputHash: HASH_A, inputSource: 'unlinked',
    measurement: { kind: 'counted', tokens: localTokens, method: 'deepseek-v41-template' },
    measuredInputTokens: localTokens,
    usage: { unCachedInputTokens: supplierTokens, outputTokens: 1 },
    totalUsageInputTokens: supplierTokens, normalizedUsageInputTokens: supplierTokens,
    deltaTokens, reconciliation, ...(reason === undefined ? {} : { reason }),
  };
}

function historicalFailed(requestId: string): InputMeasurementObservation {
  return {
    kind: 'failed', requestId, provider: 'p', model: 'm',
    descriptorRevision: 'historical-rev', inputHash: HASH_A, inputSource: 'unlinked',
    measurement: { kind: 'counted', tokens: 12, method: 'deepseek-v41-template' },
    measuredInputTokens: 12, reason: 'historical-provider-error',
  };
}

function modernPrepared(requestId: string): InputMeasurementObservation {
  return {
    kind: 'prepared', requestId, provider: 'p', model: 'm',
    descriptor: {
      revision: 'historical-rev', provider: 'p', model: 'm',
      api: 'anthropic-messages', contextWindow: 1_000_000, profile: 'legacy-cl100k-v2',
    },
    measurement: { kind: 'estimated', tokens: 7, method: 'legacy-cl100k', reason: 'modern-estimate' },
    inputHash: HASH_A, inputSource: 'unlinked',
  };
}

function modernCompleted(requestId: string): InputMeasurementObservation {
  return {
    kind: 'completed', requestId, provider: 'p', model: 'm',
    descriptorRevision: 'historical-rev', inputHash: HASH_A, inputSource: 'unlinked',
    measurement: { kind: 'estimated', tokens: 7, method: 'legacy-cl100k', reason: 'modern-estimate' },
    measuredInputTokens: 7, usage: { unCachedInputTokens: 7, outputTokens: 1 },
    totalUsageInputTokens: 7, normalizedUsageInputTokens: 7,
    deltaTokens: 0, reconciliation: 'matched',
  };
}

function expectedRequest(
  status: 'completed' | 'failed',
  preparedObservation: InputMeasurementObservation,
  terminalObservation: InputMeasurementObservation,
  invocationId = 'inv-1',
  attemptId = 'att-1',
): Record<string, unknown> {
  return {
    status,
    prepared: { ...structuredClone(preparedObservation), invocationId, attemptId },
    terminal: { ...structuredClone(terminalObservation), invocationId, attemptId },
  };
}

function expectReplayPreservingInput(
  events: Record<string, unknown>[],
  expected: Record<string, unknown>,
) {
  const before = structuredClone(events);
  const jsonl = `${events.map(item => JSON.stringify(item)).join('\n')}\n`;
  const direct = InputMeasurementLedger.replay(events);
  const reloaded = InputMeasurementLedger.replayJsonl(jsonl);

  expect(direct.diagnostics).toEqual([]);
  expect(reloaded.diagnostics).toEqual([]);
  expect(direct.requests.size).toBe(Object.keys(expected).length);
  for (const [requestKey, request] of Object.entries(expected)) {
    expect(direct.requests.get(requestKey)).toStrictEqual(request);
    expect(reloaded.requests.get(requestKey)).toStrictEqual(request);
  }
  expect(reloaded).toStrictEqual(direct);
  expect(InputMeasurementLedger.replayJsonl(jsonl)).toStrictEqual(reloaded);
  expect(events).toStrictEqual(before);
  return reloaded;
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
    const events = [event(prepared('legacy')), event(terminal('legacy'))].map(withoutSchemaVersion);

    const first = InputMeasurementLedger.replay(events);
    const second = InputMeasurementLedger.replay(events);

    expect(first.requests.get(key('legacy'))?.status).toBe('completed');
    expect(first.requests.get(key('legacy'))?.prepared?.artifactRef).toBeUndefined();
    expect(second).toEqual(first);
  });

  it('preserves historical counted prepared and completed facts through direct and JSONL replay', () => {
    const historicalPreparedObservation = historicalPrepared('legacy-counted', 12);
    const historicalCompletedObservation = historicalCompleted(
      'legacy-counted', 12, 15, 3, 'mismatch', 'historical-note',
    );
    const events = [event(historicalPreparedObservation), event(historicalCompletedObservation)];
    const expected = expectedRequest(
      'completed', historicalPreparedObservation, historicalCompletedObservation,
    );

    const reloaded = expectReplayPreservingInput(events, { [key('legacy-counted')]: expected });
    const request = reloaded.requests.get(key('legacy-counted'));
    expect(request?.terminal).not.toHaveProperty('effectiveInputTokens');
    expect(request?.terminal?.measurement).not.toHaveProperty('reason');
    expect(request?.prepared).not.toHaveProperty('artifactRef');
    if (request?.prepared?.kind !== 'prepared') throw new Error('prepared replay required');
    expect(request.prepared.descriptor).not.toHaveProperty('configuredModel');
  });

  it('preserves zero and absent fields in schema-less historical counted completions', () => {
    const historicalPreparedObservation = historicalPrepared('legacy-counted-zero', 0);
    const historicalCompletedObservation = historicalCompleted('legacy-counted-zero', 0, 0, 0, 'matched');
    const events = [event(historicalPreparedObservation), event(historicalCompletedObservation)]
      .map(withoutSchemaVersion);
    const expected = expectedRequest(
      'completed', historicalPreparedObservation, historicalCompletedObservation,
    );

    const reloaded = expectReplayPreservingInput(events, { [key('legacy-counted-zero')]: expected });
    const request = reloaded.requests.get(key('legacy-counted-zero'));
    if (request?.terminal?.kind !== 'completed') throw new Error('completed replay required');
    expect(request.terminal.measuredInputTokens).toBe(0);
    expect(request.terminal.usage).toStrictEqual({ unCachedInputTokens: 0, outputTokens: 1 });
    expect(request.terminal.totalUsageInputTokens).toBe(0);
    expect(request.terminal.normalizedUsageInputTokens).toBe(0);
    expect(request.terminal.deltaTokens).toBe(0);
    expect(request.terminal).not.toHaveProperty('effectiveInputTokens');
    expect(request.terminal).not.toHaveProperty('reason');
    expect(request.terminal.measurement).not.toHaveProperty('reason');
    expect(request.prepared).not.toHaveProperty('artifactRef');
    if (request.prepared?.kind !== 'prepared') throw new Error('prepared replay required');
    expect(request.prepared.descriptor).not.toHaveProperty('configuredModel');
  });

  it('preserves schema-less historical counted failures without adding completion fields', () => {
    const historicalPreparedObservation = historicalPrepared('legacy-counted-failed', 12);
    const historicalFailedObservation = historicalFailed('legacy-counted-failed');
    const events = [event(historicalPreparedObservation), event(historicalFailedObservation)]
      .map(withoutSchemaVersion);
    const expected = expectedRequest('failed', historicalPreparedObservation, historicalFailedObservation);

    const reloaded = expectReplayPreservingInput(events, { [key('legacy-counted-failed')]: expected });
    const request = reloaded.requests.get(key('legacy-counted-failed'));
    expect(request?.status).toBe('failed');
    if (request?.terminal?.kind !== 'failed') throw new Error('failed replay required');
    expect(request.terminal.reason).toBe('historical-provider-error');
    expect(request.terminal).not.toHaveProperty('usage');
    expect(request.terminal).not.toHaveProperty('reconciliation');
    expect(request.terminal).not.toHaveProperty('deltaTokens');
    expect(request.terminal.measurement).not.toHaveProperty('reason');
    expect(request.prepared).not.toHaveProperty('artifactRef');
    if (request.prepared?.kind !== 'prepared') throw new Error('prepared replay required');
    expect(request.prepared.descriptor).not.toHaveProperty('configuredModel');
  });

  it('keeps interleaved historical and modern request evidence independent on repeated reload', () => {
    const countedPrepared = historicalPrepared('mixed-counted', 12);
    const countedCompleted = historicalCompleted('mixed-counted', 12, 15, 3, 'mismatch', 'historical-note');
    const zeroPrepared = historicalPrepared('mixed-zero', 0);
    const zeroCompleted = historicalCompleted('mixed-zero', 0, 0, 0, 'matched');
    const failedPrepared = historicalPrepared('mixed-failed', 12);
    const failedTerminal = historicalFailed('mixed-failed');
    const modernPreparedObservation = modernPrepared('mixed-modern');
    const modernCompletedObservation = modernCompleted('mixed-modern');
    const ids = {
      counted: { invocationId: 'inv-historical', attemptId: 'att-mixed-counted' },
      zero: { invocationId: 'inv-historical', attemptId: 'att-mixed-zero' },
      failed: { invocationId: 'inv-historical', attemptId: 'att-mixed-failed' },
      modern: { invocationId: 'inv-historical', attemptId: 'att-mixed-modern' },
    };
    const events = [
      event(countedPrepared, ids.counted),
      withoutSchemaVersion(event(zeroPrepared, ids.zero)),
      event(countedCompleted, ids.counted),
      withoutSchemaVersion(event(failedPrepared, ids.failed)),
      withoutSchemaVersion(event(zeroCompleted, ids.zero)),
      event(modernPreparedObservation, ids.modern),
      withoutSchemaVersion(event(failedTerminal, ids.failed)),
      event(modernCompletedObservation, ids.modern),
    ];
    const expected = {
      [key('mixed-counted', ids.counted.invocationId, ids.counted.attemptId)]: expectedRequest(
        'completed', countedPrepared, countedCompleted, ids.counted.invocationId, ids.counted.attemptId,
      ),
      [key('mixed-zero', ids.zero.invocationId, ids.zero.attemptId)]: expectedRequest(
        'completed', zeroPrepared, zeroCompleted, ids.zero.invocationId, ids.zero.attemptId,
      ),
      [key('mixed-failed', ids.failed.invocationId, ids.failed.attemptId)]: expectedRequest(
        'failed', failedPrepared, failedTerminal, ids.failed.invocationId, ids.failed.attemptId,
      ),
      [key('mixed-modern', ids.modern.invocationId, ids.modern.attemptId)]: expectedRequest(
        'completed', modernPreparedObservation, modernCompletedObservation,
        ids.modern.invocationId, ids.modern.attemptId,
      ),
    };

    const reloaded = expectReplayPreservingInput(events, expected);
    expect(reloaded.requests.get(
      key('mixed-modern', ids.modern.invocationId, ids.modern.attemptId),
    )?.terminal?.measurement).toStrictEqual({
      kind: 'estimated', tokens: 7, method: 'legacy-cl100k', reason: 'modern-estimate',
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
