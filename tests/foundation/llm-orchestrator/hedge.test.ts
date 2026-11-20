import { legacyProviderFactory } from './provider-test-fixtures.js';
/**
 * LLMOrchestrator hedge mode tests
 * Phase 737 Step F — 2-track hedge on primary transient waiting state
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import {
  LLMAllProvidersFailedError,
} from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMAuthError, LLMNetworkError, LLMRateLimitError } from '../../../src/foundation/llm-provider/errors.js';
import type {
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';
import type { llmProviderCall } from '../../../src/foundation/llm-provider/index.js';
type LLMCallOptions = llmProviderCall.LLMCallOptions;
type ProviderAdapter = llmProviderCall.ProviderAdapter;
type ProviderStreamChunk = llmProviderCall.ProviderStreamChunk;
import type { llmProviderModelMeasurement } from '../../../src/foundation/llm-provider/index.js';
type InputMeasurementObservation = llmProviderModelMeasurement.InputMeasurementObservation;
import type { ProviderConnection } from './provider-test-fixtures.js';
import type { LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/index.js';
import { InvocationSelectionLedger } from '../../../src/foundation/llm-orchestrator/invocation-selection-ledger.js';
import { computeDynamicCallTimeoutMs } from '../../../src/foundation/llm-orchestrator/utils.js';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../../src/foundation/llm-orchestrator/defaults.js';
import { internalsOf, providerStatesOf, replaceProviderStates } from './test-internals.js';

/** Real-timer mock tracks: slow enough to keep the hedge open, fast enough to win after startup. */
const HEDGE_SLOW_CALL_DELAY_MS = 500;
const HEDGE_PRIMARY_STREAM_DELAY_MS = 100;
const HEDGE_FAST_CALL_DELAY_MS = 50;

function createMockProvider(
  name: string,
  opts: {
    streamChunks?: ProviderStreamChunk[];
    streamError?: Error;
    streamDelayMs?: number;
    callResponse?: LLMResponse;
    callError?: Error;
    callDelayMs?: number;
    measurementRequestId?: string;
    inputTokens?: number;
    onCallOptions?: (options: LLMCallOptions) => void;
    onStreamOptions?: (options: LLMCallOptions) => void;
  } = {},
): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    prepareInputMeter: opts.inputTokens === undefined ? undefined : async () => ({
      descriptor: {
        revision: `${name}-timeout-revision`, provider: name, model: 'mock-model',
        api: 'test', contextWindow: 1_000_000, profile: 'test',
      },
      capability: { kind: 'complete_only' as const },
      measure: () => ({
        kind: 'estimated' as const, tokens: opts.inputTokens!, method: 'deepseek-v41-text' as const, reason: 'test',
      }),
    }),
    async call(callOpts?: LLMCallOptions) {
      if (callOpts) opts.onCallOptions?.(callOpts);
      if (opts.measurementRequestId) {
        callOpts?.onInputMeasurement?.({
          kind: 'completed', requestId: opts.measurementRequestId,
          provider: name, model: 'mock-model', inputSource: 'unlinked', reconciliation: 'no_usage',
          artifactRef: {
            artifactId: `input-artifact-${opts.measurementRequestId}`, schemaVersion: 1,
            status: 'unavailable', hashAlgorithm: 'sha256', reason: 'test_capture_unavailable',
          },
        });
      }
      if (opts.callDelayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, opts.callDelayMs);
          callOpts?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('AbortError'));
          });
        });
      }
      if (opts.callError) throw opts.callError;
      return opts.callResponse ?? {
        content: [{ type: 'text', text: `Response from ${name}` }],
        stop_reason: 'end_turn',
      };
    },
    stream: opts.streamChunks || opts.streamError
      ? async function* (streamOpts?: LLMCallOptions) {
          if (streamOpts) opts.onStreamOptions?.(streamOpts);
          if (opts.measurementRequestId) {
            streamOpts?.onInputMeasurement?.({
              kind: 'completed', requestId: opts.measurementRequestId,
              provider: name, model: 'mock-model', inputSource: 'unlinked', reconciliation: 'no_usage',
          artifactRef: {
            artifactId: `input-artifact-${opts.measurementRequestId}`, schemaVersion: 1,
            status: 'unavailable', hashAlgorithm: 'sha256', reason: 'test_capture_unavailable',
          },
            });
          }
          if (opts.streamDelayMs) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, opts.streamDelayMs);
              streamOpts?.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('AbortError'));
              });
            });
          }
          if (opts.streamError) throw opts.streamError;
          for (const chunk of (opts.streamChunks ?? [])) {
            yield chunk;
          }
        }
      : undefined,
  };
}

function createOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const noopSink: LLMEventSink = { emit: () => {} };
  const findAdapter = (cfg: ProviderConnection) => {
    if (cfg.providerId === primary.name) return primary;
    return fallbacks.find(fb => fb.name === cfg.providerId) ?? primary;
  };
  const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
    primary: { providerId: primary.name, authentication: { kind: 'api_key' as const, value: 'test', identity: 'test' }, model: primary.model, apiFormat: 'anthropic' as const },
    fallbacks: fallbacks.map(fb => ({ providerId: fb.name, authentication: { kind: 'api_key' as const, value: 'test', identity: 'test' }, model: fb.model, apiFormat: 'anthropic' as const })),
    maxAttempts: 1,
    retryDelayMs: 0, // 禁用重试等待，保持可控竞态即时推进。
    events: noopSink,
    providerFactory: legacyProviderFactory((cfg) => findAdapter(cfg)),
  });
  return service;
}

function forceProviderWaiting(service: LLMOrchestratorImpl, index: number, cause: 'transient' | 'permanent' | 'rate_limit') {
  const now = Date.now();
  replaceProviderStates(service, [{
    providerId: internalsOf(service).providerRuntime.providerIds()[index],
    status: 'waiting',
    retryAt: now + 60_000,
    lastError: { class: cause, at: now, message: 'forced provider failure' },
    consecutiveFailures: 1,
  }]);
}

function attachEventSpy(service: LLMOrchestratorImpl) {
  const emitted: LLMEvent[] = [];
  const sink = (service as any).events as LLMEventSink;
  const originalEmit = sink.emit.bind(sink);
  sink.emit = (event: LLMEvent) => {
    emitted.push(event);
    originalEmit(event);
  };
  return emitted;
}



describe('LLMOrchestratorImpl hedge mode (Phase 737)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hedge_primary_recovered: primary first chunk wins, provider state recovers', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        {
          type: 'done',
          stopReason: 'end_turn',
          usage: {
            inputTokens: 15,
            outputTokens: 5,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 2,
            totalTokens: 20,
            details: { reasoningTokens: 1 },
          },
        },
      ],
    });
    const fallback = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
      callDelayMs: HEDGE_SLOW_CALL_DELAY_MS,
    });
    const service = createOrchestrator(primary, [fallback]);
    forceProviderWaiting(service, 0, 'transient');
    const events = attachEventSpy(service);

    const chunks: LLMStreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(events.some((e) => e.type === 'hedge_started')).toBe(true);
    const recovered = events.find((e) => e.type === 'hedge_primary_recovered');
    expect(recovered).toMatchObject({
      usage: {
        inputTokens: 15,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        totalTokens: 20,
        details: { reasoningTokens: 1 },
      },
    });
    expect(chunks).toEqual([
      { type: 'text_delta', delta: 'hello' },
      {
        type: 'done',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 15,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 2,
          totalTokens: 20,
          details: { reasoningTokens: 1 },
        },
      },
    ]);
    expect(service.getProviderInfo()?.name).toBe('primary');
    expect(providerStatesOf(service)[0]).toMatchObject({
      status: 'available',
      retryAt: undefined,
      consecutiveFailures: 0,
    });
  });

  it('hedge_fallback_committed: primary slow/fail, fallback wins, wrap as stream', async () => {
    let primaryTimeoutMs: number | undefined;
    let fallbackTimeoutMs: number | undefined;
    const primary = createMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
      streamDelayMs: HEDGE_PRIMARY_STREAM_DELAY_MS,
      measurementRequestId: 'hedge-primary-request',
      inputTokens: 10,
      onStreamOptions: options => { primaryTimeoutMs = options.timeoutMs; },
    });
    const fallback = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      callDelayMs: HEDGE_FAST_CALL_DELAY_MS,
      measurementRequestId: 'hedge-fallback-request',
      inputTokens: 50_000,
      onCallOptions: options => { fallbackTimeoutMs = options.timeoutMs; },
    });
    const service = createOrchestrator(primary, [fallback]);
    forceProviderWaiting(service, 0, 'transient');
    const events = attachEventSpy(service);
    const observations: InputMeasurementObservation[] = [];

    const chunks: LLMStreamChunk[] = [];
    for await (const c of service.stream({
      messages: [{ role: 'user', content: 'hi' }],
      onInputMeasurement: fact => observations.push(fact),
    })) {
      chunks.push(c);
    }

    expect(events.some((e) => e.type === 'hedge_started')).toBe(true);
    expect(events.some((e) => e.type === 'hedge_fallback_committed')).toBe(true);
    expect(chunks.map(c => c.type)).toEqual(['text_delta', 'done']);
    expect((chunks[0] as { delta?: string }).delta).toBe('fb response');
    expect(service.getProviderInfo()?.name).toBe('fb1');
    const started = events.find(e => e.type === 'call_invocation_started');
    expect(started).toBeDefined();
    if (started?.type !== 'call_invocation_started') throw new Error('expected invocation start');
    expect(observations.map(fact => fact.requestId).sort()).toEqual([
      'hedge-fallback-request', 'hedge-primary-request',
    ]);
    expect(observations.every(fact =>
      fact.invocationId === started.invocationId
      && fact.attemptId === `${started.attemptId}:request:${fact.requestId}`)).toBe(true);
    expect(new Set(observations.map(fact => fact.attemptId)).size).toBe(2);
    expect(new Set(observations.map(fact => fact.artifactRef?.artifactId))).toEqual(new Set([
      'input-artifact-hedge-primary-request', 'input-artifact-hedge-fallback-request',
    ]));
    expect(events.filter(e => e.type === 'input_measurement')).toHaveLength(2);
    expect(primaryTimeoutMs).toBe(computeDynamicCallTimeoutMs(DEFAULT_LLM_TIMEOUT_MS, 10));
    expect(fallbackTimeoutMs).toBe(computeDynamicCallTimeoutMs(DEFAULT_LLM_TIMEOUT_MS, 50_000));
    expect(observations.every(fact => fact.measurement === undefined)).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } });

    const replay = InvocationSelectionLedger.replay(events);
    const invocation = replay.invocations.get(started.invocationId);
    const winner = invocation?.attempts.get(invocation.selectedAttemptId!);
    expect(winner).toMatchObject({
      provider: 'fb1', status: 'selected', requestIds: ['hedge-fallback-request'],
    });
    expect([...invocation!.attempts.values()].find(item => item.provider === 'primary')).toMatchObject({
      status: 'failed', requestIds: ['hedge-primary-request'],
    });
    expect(replay.diagnostics).toEqual([]);
  });

  it('hedge double fail: primary error + all fallbacks fail → throw LLMAllProvidersFailedError', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
    });
    const fb1 = createMockProvider('fb1', {
      callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
    });
    const fb2 = createMockProvider('fb2', {
      callError: new LLMNetworkError('fb2', new Error('ECONNREFUSED')),
    });
    const service = createOrchestrator(primary, [fb1, fb2]);
    forceProviderWaiting(service, 0, 'transient');

    await expect(async () => {
      for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
    }).rejects.toThrow(LLMAllProvidersFailedError);
  });

  it('hedge gate: primary waiting with permanent cause → no hedge / sequential failover', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMAuthError('primary', 401),
    });
    const fallback = createMockProvider('fb1', {
      streamChunks: [
        { type: 'text_delta', delta: 'fb' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    });
    const service = createOrchestrator(primary, [fallback]);
    forceProviderWaiting(service, 0, 'permanent');
    const events = attachEventSpy(service);

    const chunks: LLMStreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(events.some((e) => e.type === 'hedge_started')).toBe(false);
    expect(chunks.some(c => c.type === 'text_delta' && c.delta === 'fb')).toBe(true);
  });

  it('hedge gate: primary waiting with rate_limit cause → no hedge', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMRateLimitError('primary'),
    });
    const fallback = createMockProvider('fb1', {
      streamChunks: [
        { type: 'text_delta', delta: 'fb' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    });
    const service = createOrchestrator(primary, [fallback]);
    forceProviderWaiting(service, 0, 'rate_limit');
    const events = attachEventSpy(service);

    const chunks: LLMStreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(events.some((e) => e.type === 'hedge_started')).toBe(false);
    expect(chunks.some(c => c.type === 'text_delta' && c.delta === 'fb')).toBe(true);
  });

  it('provider_attempt_failed payload contains errorClass + userActionHint', async () => {
    const primary = createMockProvider('primary', {
      streamError: new LLMAuthError('primary', 401, 'invalid api key'),
    });
    const fb1 = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
      },
    });
    const service = createOrchestrator(primary, [fb1]);
    // primary available → sequential failover path
    const events = attachEventSpy(service);

    await (async () => {
      for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
    })().catch(() => { /* silent: expected-failure */ });

    const failedEvent = events.find((e) => e.type === 'provider_attempt_failed' && (e as any).provider === 'primary');
    expect(failedEvent).toBeDefined();
    expect((failedEvent as any).errorClass).toBe('permanent');
    expect((failedEvent as any).userActionHint).toBe('rotate_api_key');
  });
});
