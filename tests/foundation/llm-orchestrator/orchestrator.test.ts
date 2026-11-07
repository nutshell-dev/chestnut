/**
 * LLMOrchestrator stream/call/hedge regression tests — Phase 895 + Phase 896
 *
 * Phase 895:
 * 1. stream() user abort during idle probe propagates as AbortError with reason.
 * 2. stream() ending without done chunk emits reset + provider_failed and records provider recovery state.
 * 3. stream() yielding only done without content failovers.
 *
 * Phase 896:
 * 1. call() user abort propagates immediately without collecting as failure.
 * 2. hedge A-win drain ending without done chunk emits reset + provider_failed.
 * 3. B-all-failed A-wins drain error emits reset and records provider recovery state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { LLMAllProvidersFailedError, LLMRecoveryWaitRequiredError } from '../../../src/foundation/llm-orchestrator/errors.js';
import { LLMAuthError, LLMNetworkError, LLMQuotaError } from '../../../src/foundation/llm-provider/errors.js';
import type {
  LLMEventSink,
  LLMEvent,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';
import type { ProviderAdapter, ProviderConfig, ProviderStreamChunk } from '../../../src/foundation/llm-provider/index.js';
import type { LLMStreamChunk } from '../../../src/foundation/llm-orchestrator/index.js';
import { resolveLLMConfig } from '../../../src/assembly/config/config-load.js';
import { createGlobalConfigSchema } from '../../../src/assembly/config/compose-config.js';

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}

// Phase 896 helper: declarative chunk/error based mock provider.
function createMockProvider(
  name: string,
  opts: {
    streamChunks?: ProviderStreamChunk[];
    streamError?: Error;
    streamErrorAfter?: number;
    callResponse?: LLMResponse;
    callError?: Error;
    callDelayMs?: number;
  } = {},
): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    async call(callOpts?: { signal?: AbortSignal }) {
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
    stream: opts.streamChunks || opts.streamError || opts.streamErrorAfter !== undefined
      ? async function* (streamOpts?: { signal?: AbortSignal }) {
          const chunks = opts.streamChunks ?? [];
          let count = 0;
          for (const chunk of chunks) {
            yield chunk;
            count++;
            if (opts.streamErrorAfter !== undefined && count >= opts.streamErrorAfter) {
              throw opts.streamError ?? new Error('stream error');
            }
          }
          if (opts.streamError && chunks.length === 0) {
            throw opts.streamError;
          }
        }
      : undefined,
  };
}

function createOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const noopSink: LLMEventSink = { emit: () => {} };
  const findAdapter = (cfg: ProviderConfig) => {
    if (cfg.name === primary.name) return primary;
    return fallbacks.find(fb => fb.name === cfg.name) ?? primary;
  };
  const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
    primary: { name: primary.name, apiKey: 'test', model: primary.model, apiFormat: 'anthropic' as const },
    fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model, apiFormat: 'anthropic' as const })),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: noopSink,
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
    createProviderAdapter: (cfg) => findAdapter(cfg),
  });
  return service;
}

function providerState(service: LLMOrchestratorImpl, index: number) {
  const providerId = service.getProviderIdentities()[index];
  return (service as any).providerStates.find((state: any) => state.providerId === providerId);
}

function forceProviderWaiting(service: LLMOrchestratorImpl, index: number, cause: 'transient' | 'permanent' | 'rate_limit') {
  const now = Date.now();
  const providerId = service.getProviderIdentities()[index];
  const previous = providerState(service, index);
  const states = (service as any).providerStates.filter((state: any) => state.providerId !== providerId);
  states.push({
    ...previous,
    providerId,
    status: 'waiting',
    retryAt: now + 60_000,
    lastError: { class: cause, at: now, message: `forced ${cause} failure` },
    consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
  });
  (service as any).providerStates = states;
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

describe('Phase 1268 Step E: provider recovery default enabled', () => {
  it('缺段配置经 load/build 后由 owner providerStates 记录 primary+2 fallbacks 的恢复事实', async () => {
    const globalConfig = createGlobalConfigSchema().parse({
      llm: {
        primary: { preset: 'anthropic', api_key: 'sk-p', model: 'claude-test' },
        fallbacks: [
          { preset: 'openai', api_key: 'sk-f1', model: 'gpt-test' },
          { preset: 'moonshot', api_key: 'sk-f2', model: 'kimi-test' },
        ],
      },
    });
    const llmConfig = resolveLLMConfig(globalConfig);

    const primary = createMockProvider('anthropic', {
      callError: new LLMNetworkError('anthropic', new Error('primary down')),
    });
    const fb1 = createMockProvider('openai');
    const fb2 = createMockProvider('moonshot');
    const findAdapter = (cfg: ProviderConfig) => {
      if (cfg.name === primary.name) return primary;
      if (cfg.name === fb1.name) return fb1;
      return fb2;
    };

    const { sink, emitted } = createMockSink();
    const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      ...llmConfig,
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      createProviderAdapter: (cfg) => findAdapter(cfg),
    });

    expect(service.getProviderIdentities()).toHaveLength(3);
    // 缺失的 provider state 即 available；第一次真实失败后由 owner 统一记账。
    expect((service as any).providerStates).toEqual([]);
    await service.call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(providerState(service, 0)).toMatchObject({
      providerId: service.getProviderIdentities()[0],
      status: 'waiting',
      consecutiveFailures: 1,
      lastError: { class: 'transient', at: expect.any(Number), message: expect.stringContaining('primary down') },
    });
    expect(emitted.some(e => e.type === 'fallback_switched' && e.from === 'anthropic' && e.to === 'openai')).toBe(true);
    await service.close();
  });
});

describe('LLMOrchestratorImpl Phase 896 fixes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('propagates user abort from call() immediately without collecting as failure', async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort({ type: 'user' });
    const primary = createMockProvider('primary');
    const primaryCallSpy = vi.spyOn(primary, 'call').mockRejectedValue(new Error('should not be thrown'));
    const fallback = createMockProvider('fb1');
    const fallbackCallSpy = vi.spyOn(fallback, 'call').mockResolvedValue({
      content: [{ type: 'text', text: 'fb response' }],
      stop_reason: 'end_turn',
    });
    const service = createOrchestrator(primary, [fallback]);

    await expect(service.call({ messages: [{ role: 'user', content: 'hi' }], signal: abortCtrl.signal }))
      .rejects.toThrow('Execution aborted (cause=user)');

    expect(primaryCallSpy).not.toHaveBeenCalled();
    expect(fallbackCallSpy).not.toHaveBeenCalled();
  });

  it('call() announces the fallback actually attempted after filtering waiting providers', async () => {
    const primary = createMockProvider('primary', {
      callError: new LLMNetworkError('primary', new Error('primary down')),
    });
    const skipped = createMockProvider('fb1');
    const attempted = createMockProvider('fb2');
    const service = createOrchestrator(primary, [skipped, attempted]);
    forceProviderWaiting(service, 1, 'transient');
    const events = attachEventSpy(service);

    await expect(service.call({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();

    const switches = events.filter((event) => event.type === 'fallback_switched');
    expect(switches).toEqual([
      expect.objectContaining({ from: 'primary', to: 'fb2', reason: 'primary_exhausted' }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'call_attempt_result',
      provider: 'fb1',
      outcome: 'skipped',
      reason: 'provider_recovery_floor',
    }));
  });

  it('call() records failover when the primary provider is already waiting', async () => {
    const primary = createMockProvider('primary');
    const fallback = createMockProvider('fb1');
    const service = createOrchestrator(primary, [fallback]);
    forceProviderWaiting(service, 0, 'transient');
    const events = attachEventSpy(service);

    await expect(service.call({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();

    expect(events).toContainEqual(expect.objectContaining({
      type: 'fallback_switched',
      from: 'primary',
      to: 'fb1',
      reason: 'primary_breaker_open',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'call_attempt_result',
      provider: 'primary',
      outcome: 'skipped',
      reason: 'provider_recovery_floor',
    }));
  });

  it('hedge A-win emits reset and provider_failed when primary drain ends without done', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [{ type: 'text_delta', delta: 'hello' }], // clean EOF, no done
    });
    const fallback = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
      callDelayMs: 500,
    });
    const service = createOrchestrator(primary, [fallback]);
    forceProviderWaiting(service, 0, 'transient');
    const events = attachEventSpy(service);

    const failuresBefore = providerState(service, 0)?.consecutiveFailures ?? 0;

    const chunks: LLMStreamChunk[] = [];
    let caught: Error | undefined;
    try {
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }
    } catch (e) {
      caught = e as Error;
    }

    expect(chunks.find(c => c.type === 'reset')).toBeDefined();
    expect(chunks.find(c => c.type === 'provider_failed')).toBeDefined();
    expect(events.some(e => e.type === 'stream_reset')).toBe(true);
    expect(caught).toBeDefined();
    expect(providerState(service, 0)).toMatchObject({
      status: 'waiting',
      consecutiveFailures: failuresBefore + 1,
      lastError: { class: 'transient', at: expect.any(Number) },
    });
  });

  it('hedge B-all-failed A-wins drain error emits reset and records provider failure', async () => {
    const drainErr = new LLMNetworkError('primary', new Error('ECONNRESET'));
    const primary = createMockProvider('primary', {
      streamChunks: [{ type: 'text_delta', delta: 'hello' }],
      streamErrorAfter: 1,
      streamError: drainErr,
    });
    const fb1 = createMockProvider('fb1', {
      callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
    });
    const service = createOrchestrator(primary, [fb1]);
    forceProviderWaiting(service, 0, 'transient');
    const events = attachEventSpy(service);

    const failuresBefore = providerState(service, 0)?.consecutiveFailures ?? 0;

    const chunks: LLMStreamChunk[] = [];
    let caught: Error | undefined;
    try {
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }
    } catch (e) {
      caught = e as Error;
    }

    expect(chunks.find(c => c.type === 'reset')).toBeDefined();
    expect(events.some(e => e.type === 'hedge_primary_post_first_chunk_failure')).toBe(true);
    expect(events.some(e => e.type === 'stream_reset')).toBe(true);
    expect(caught).toBeDefined();
    expect(providerState(service, 0)).toMatchObject({
      status: 'waiting',
      consecutiveFailures: failuresBefore + 1,
      lastError: { class: 'transient', at: expect.any(Number) },
    });
  });
});

// Phase 895 helper: function-based mock provider for streaming scenarios.
function createMockStreamProvider(
  name: string,
  streamImpl?: (opts: { signal?: AbortSignal }) => AsyncGenerator<ProviderStreamChunk>,
  callImpl?: (opts?: { signal?: AbortSignal }) => Promise<any>,
): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    async call(opts?: { signal?: AbortSignal }) {
      if (callImpl) return callImpl(opts);
      return {
        content: [{ type: 'text', text: `Response from ${name}` }],
        stop_reason: 'end_turn',
      };
    },
    stream: streamImpl
      ? streamImpl
      : async function* () {
          yield { type: 'text_delta', delta: `Chunk from ${name}` };
          yield { type: 'done' };
        },
  };
}

const MOCK_PRIMARY_CONFIG = { name: 'primary', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const };
const MOCK_FALLBACK_CONFIG = { name: 'fallback', apiKey: 'test', model: 'test', apiFormat: 'anthropic' as const };

// Delay before the probe aborts the user signal.
// Derivation: streamIdleTimeoutMs=50ms must fire first; 20ms is short enough
// to keep the test fast while ensuring the probe runs after idle timeout.
const PROBE_ABORT_DELAY_MS = 20;

describe('Phase 895 — orchestrator stream fixes', () => {
  it('throws AbortError with user reason when user aborts during idle probe', async () => {
    const { sink } = createMockSink();
    const abortCtrl = new AbortController();

    const primary = createMockStreamProvider(
      'primary',
      async function* (opts: { signal?: AbortSignal }) {
        yield { type: 'text_delta', delta: 'first' };
        // Hang until the idle timeout aborts the merged signal.
        await new Promise<void>((_, reject) => {
          opts.signal?.addEventListener('abort', () => {
            reject(new Error('AbortError'));
          });
        });
        yield { type: 'done' };
      },
      async (opts?: { signal?: AbortSignal }) => {
        // Simulate a probe that notices the user abort after a short delay.
        await new Promise((resolve) => setTimeout(resolve, PROBE_ABORT_DELAY_MS));
        abortCtrl.abort({ type: 'user' as const });
        const err = new Error('Execution aborted');
        err.name = 'AbortError';
        throw err;
      },
    );

    const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: MOCK_PRIMARY_CONFIG,
      maxAttempts: 2,
      retryDelayMs: 0,
      events: sink,
      createProviderAdapter: () => primary as any,
    });

    const promise = (async () => {
      const chunks: LLMStreamChunk[] = [];
      for await (const chunk of service.stream({
        messages: [],
        streamIdleTimeoutMs: 50,
        streamIdleProbeTimeoutMs: 50,
        signal: abortCtrl.signal,
      })) {
        chunks.push(chunk);
      }
      return chunks;
    })();

    let caught: Error | undefined;
    try {
      await promise;
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.name).toBe('AbortError');
    expect(caught!.message).toMatch(/Execution aborted/);
    expect((caught! as Error & { cause?: { type: string } }).cause?.type).toBe('user');
  });

  it('records provider failure when stream ends without done chunk', async () => {
    const { sink, emitted } = createMockSink();

    const primary = createMockStreamProvider(
      'primary',
      async function* () {
        yield { type: 'text_delta', delta: 'partial' };
        // Clean EOF without a done chunk.
      },
    );

    const fallback = createMockStreamProvider(
      'fallback',
      async function* () {
        yield { type: 'text_delta', delta: 'full' };
        yield { type: 'done' };
      },
    );

    const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: MOCK_PRIMARY_CONFIG,
      fallbacks: [MOCK_FALLBACK_CONFIG],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1_000 },
      createProviderAdapter: (cfg) => (cfg.name === fallback.name ? fallback : primary) as any,
    });

    const failuresBefore = providerState(service, 0)?.consecutiveFailures ?? 0;

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [], streamIdleTimeoutMs: 50 })) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'text_delta').map((c: any) => c.delta)).toEqual(['partial', 'full']);
    expect(chunks.filter((c) => c.type === 'reset').length).toBe(1);
    expect(chunks.some((c) => c.type === 'done')).toBe(true);
    expect(chunks.some((c) => c.type === 'provider_failed' && (c as any).provider === 'primary')).toBe(true);
    expect(providerState(service, 0)).toMatchObject({
      status: 'waiting',
      consecutiveFailures: failuresBefore + 1,
      lastError: { class: 'transient', at: expect.any(Number) },
    });
    expect(emitted.some((e) => e.type === 'fallback_switched')).toBe(true);
  });

  it('completes thinking-only streams and preserves their signature', async () => {
    const primary = createMockStreamProvider('primary', async function* () {
      yield { type: 'thinking_delta', delta: 'reasoning' };
      yield { type: 'thinking_signature', signature: 'signed' };
      yield { type: 'done', stopReason: 'end_turn' };
    });
    const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: MOCK_PRIMARY_CONFIG,
      maxAttempts: 1,
      retryDelayMs: 0,
      events: { emit: () => {} },
      circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 1_000 },
      createProviderAdapter: () => primary as any,
    });
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) chunks.push(chunk);

    expect(chunks).toEqual([
      { type: 'thinking_delta', delta: 'reasoning' },
      { type: 'thinking_signature', signature: 'signed' },
      { type: 'done', stopReason: 'end_turn' },
    ]);
    const successState = providerState(service, 0);
    expect(successState).toMatchObject({
      status: 'available',
      consecutiveFailures: 0,
      lastSuccessAt: expect.any(Number),
      cacheValidUntil: expect.any(Number),
    });
    expect(successState.cacheValidUntil - successState.lastSuccessAt).toBe(300_000);
    expect((service as any).lastSuccessProvider).toMatchObject({ name: 'primary', generation: 0 });
  });

  it('keeps legal tool-use streams as valid content', async () => {
    const primary = createMockStreamProvider('primary', async function* () {
      yield { type: 'tool_use_start', toolUse: { id: 'tool-1', name: 'read' } };
      yield { type: 'tool_use_delta', toolUse: { id: 'tool-1', name: 'read', partialInput: '{}' } };
      yield { type: 'done', stopReason: 'tool_use' };
    });
    const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: MOCK_PRIMARY_CONFIG,
      maxAttempts: 1,
      retryDelayMs: 0,
      events: { emit: () => {} },
      createProviderAdapter: () => primary as any,
    });
    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) chunks.push(chunk);

    expect(chunks.map(c => c.type)).toEqual(['tool_use_start', 'tool_use_delta', 'done']);
    expect(chunks.some(c => c.type === 'reset' || c.type === 'provider_failed')).toBe(false);
  });

  it('failovers when stream yields only done without content', async () => {
    const { sink, emitted } = createMockSink();

    const primary = createMockStreamProvider(
      'primary',
      async function* () {
        yield { type: 'done', stopReason: 'end_turn' };
      },
    );

    const fallback = createMockStreamProvider(
      'fallback',
      async function* () {
        yield { type: 'text_delta', delta: 'fallback-content' };
        yield { type: 'done' };
      },
    );

    const service = new LLMOrchestratorImpl({
      lifecycle: { mode: 'ephemeral' },
      primary: MOCK_PRIMARY_CONFIG,
      fallbacks: [MOCK_FALLBACK_CONFIG],
      maxAttempts: 1,
      retryDelayMs: 0,
      events: sink,
      createProviderAdapter: (cfg) => (cfg.name === fallback.name ? fallback : primary) as any,
    });

    const chunks: LLMStreamChunk[] = [];
    for await (const chunk of service.stream({ messages: [] })) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'reset').length).toBe(1);
    expect(chunks.filter((c) => c.type === 'done').length).toBe(1);
    expect(chunks.some((c) => c.type === 'text_delta' && (c as any).delta === 'fallback-content')).toBe(true);
    expect(chunks.some((c) => c.type === 'provider_failed' && (c as any).provider === 'primary')).toBe(true);
    expect(emitted.some((e) => e.type === 'fallback_switched')).toBe(true);
  });
});
describe('phase 1776 Step B/D: permanent/quota provider recovery', () => {
  it('permanent（LLMAuthError）真实失败写 providerStates，不做轮内重试', async () => {
    const primary = createMockProvider('primary', {
      callError: new LLMAuthError('anthropic', 401, 'invalid api key'),
    });
    const service = createOrchestrator(primary, []);
    await expect(
      service.call({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeDefined();

    expect(providerState(service, 0)).toMatchObject({
      status: 'waiting',
      consecutiveFailures: 1,
      lastError: { class: 'permanent', at: expect.any(Number), message: expect.stringContaining('invalid api key') },
    });
  });

  it('quota（usage limit 时间窗）真实失败写 providerStates，不做轮内重试', async () => {
    const primary = createMockProvider('primary', {
      callError: new LLMQuotaError('kimi', "You've reached your 5-hour usage limit."),
    });
    const service = createOrchestrator(primary, []);
    await expect(
      service.call({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeDefined();

    expect(providerState(service, 0)).toMatchObject({
      status: 'waiting',
      consecutiveFailures: 1,
      lastError: { class: 'quota', at: expect.any(Number), message: expect.stringContaining('usage limit') },
    });
  });

  it('waiting provider 的 retryAt 到点后放行真实 call，成功恢复 available', async () => {
    let calls = 0;
    const primary = createMockProvider('primary', {
      callError: new LLMNetworkError('primary', new Error('temporary outage')),
    });
    const originalCall = primary.call.bind(primary);
    primary.call = async (opts) => {
      calls++;
      if (calls === 1) return originalCall(opts);
      return {
        content: [{ type: 'text', text: 'recovered' }],
        stop_reason: 'end_turn',
      };
    };
    const service = createOrchestrator(primary, []);
    const request = { messages: [{ role: 'user' as const, content: 'hi' }] };

    await expect(service.call(request)).rejects.toBeDefined();
    const waiting = providerState(service, 0);
    expect(waiting).toMatchObject({ status: 'waiting', consecutiveFailures: 1 });
    (service as any).providerStates = (service as any).providerStates.map((state: any) =>
      state.providerId === waiting.providerId ? { ...state, retryAt: Date.now() - 1 } : state
    );

    await expect(service.call(request)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'recovered' }],
    });
    expect(calls).toBe(2);
    const recovered = providerState(service, 0);
    expect(recovered).toMatchObject({
      status: 'available',
      consecutiveFailures: 0,
      lastSuccessAt: expect.any(Number),
      cacheValidUntil: expect.any(Number),
    });
    expect(recovered.cacheValidUntil - recovered.lastSuccessAt).toBe(300_000);
    await service.close();
  });

  it('quota 失败后恢复下界内不真发，新用户干预放行一次真实 call', async () => {
    let calls = 0;
    const primary = createMockProvider('primary', {
      callError: new LLMQuotaError('kimi', 'quota exceeded'),
    });
    const originalCall = primary.call.bind(primary);
    primary.call = async (opts) => {
      calls++;
      return originalCall(opts);
    };
    const service = createOrchestrator(primary, []);
    const request = { messages: [{ role: 'user' as const, content: 'hi' }] };

    await expect(service.call(request)).rejects.toBeDefined();
    await expect(service.call(request)).rejects.toBeInstanceOf(LLMRecoveryWaitRequiredError);
    expect(calls).toBe(1);

    await expect(service.call({
      ...request,
      recoveryFacts: { interventionIds: ['retry-quota-after-user-intervention'] },
    })).rejects.toBeDefined();
    expect(calls).toBe(2);
    await service.close();
  });
});
