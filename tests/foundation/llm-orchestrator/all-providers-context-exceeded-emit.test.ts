import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import type {
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
  LLMEvent,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createMockProvider(
  name: string,
  opts: {
    streamChunks?: StreamChunk[];
    streamError?: Error;
  } = {},
): ProviderAdapter {
  return {
    name,
    model: 'mock-model',
    async call() {
      return { content: [{ type: 'text', text: `Response from ${name}` }], stop_reason: 'end_turn' };
    },
    stream: opts.streamChunks || opts.streamError
      ? async function* () {
          if (opts.streamError) throw opts.streamError;
          for (const chunk of opts.streamChunks ?? []) {
            yield chunk;
          }
        }
      : undefined,
    onStreamParseError: undefined,
    onToolArgParseError: undefined,
  };
}

function createOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const noopSink: LLMEventSink = { emit: () => {} };
  const service = new LLMOrchestratorImpl({
    primary: { name: primary.name, apiKey: 'test', model: primary.model, maxTokens: 1024 },
    fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model, maxTokens: 1024 })),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: noopSink,
    circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60_000 },
  });
  (service as any).primary = primary;
  (service as any).fallbacks = fallbacks;
  return service;
}

function forceBreakerOpen(service: LLMOrchestratorImpl, index: number, cause: 'transient' | 'permanent' | 'rate_limit') {
  const breaker = (service as any).breakers[index] as CircuitBreaker;
  breaker['onFailure'](cause);
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

vi.mock('../../../src/foundation/llm-provider/anthropic.js', () => ({
  AnthropicAdapter: class MockAnthropicAdapter {
    name = 'mock-anthropic';
    model = 'mock-model';
    constructor(public config: any) {}
    async call() {
      return { content: [{ type: 'text', text: 'mock response' }], stop_reason: 'end_turn' };
    }
    async *stream() {
      yield { type: 'text_delta', delta: 'mock chunk' };
      yield { type: 'done' };
    }
  },
}));

describe('orchestrator all-providers context_exceeded emit (phase 1030 / audit-2026-05-18 NEW.P1.principle-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('all 2 providers context_exceeded → emit 1 + throw 1', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
    });
    const fb1 = createMockProvider('fb1', {
      streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
    });
    const service = createOrchestrator(primary, [fb1]);
    const events = attachEventSpy(service);

    await expect(async () => {
      const stream = service.stream({ messages: [], tools: [] });
      for await (const _chunk of stream) { /* drain */ }
    }).rejects.toThrow(/exhausted with context_window_exceeded/);

    const allCtxExceededEvents = events.filter((e) => e.type === 'all_providers_context_exceeded');
    expect(allCtxExceededEvents.length).toBe(1);
    expect(allCtxExceededEvents[0]).toMatchObject({
      totalAttempted: 2,
      skippedCount: 0,
    });
  });

  it('1 skipped + 1 attempted context_exceeded → totalAttempted=1 skippedCount=1', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
    });
    const fb1 = createMockProvider('fb1', {
      streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
    });
    const service = createOrchestrator(primary, [fb1]);
    const events = attachEventSpy(service);

    // Open primary's breaker so it gets skipped on next attempt
    // Use 'permanent' cause to avoid triggering hedge path (phase 737)
    forceBreakerOpen(service, 0, 'permanent');

    await expect(async () => {
      const stream = service.stream({ messages: [], tools: [] });
      for await (const _chunk of stream) { /* drain */ }
    }).rejects.toThrow(/exhausted with context_window_exceeded/);

    const allCtxExceededEvents = events.filter((e) => e.type === 'all_providers_context_exceeded');
    expect(allCtxExceededEvents.length).toBe(1);
    expect(allCtxExceededEvents[0]).toMatchObject({
      totalAttempted: 1,
      skippedCount: 1,
    });
  });

  it('mixed failure (1 context_exceeded + 1 other) → no emit (走 LLMAllProvidersFailedError path)', async () => {
    const primary = createMockProvider('primary', {
      streamChunks: [{ type: 'done', stopReason: 'model_context_window_exceeded' }],
    });
    const fb1 = createMockProvider('fb1', {
      streamError: new Error('network failed'),
    });
    const service = createOrchestrator(primary, [fb1]);
    const events = attachEventSpy(service);

    await expect(async () => {
      const stream = service.stream({ messages: [], tools: [] });
      for await (const _chunk of stream) { /* drain */ }
    }).rejects.toThrow(/All LLM providers failed/);

    const allCtxExceededEvents = events.filter((e) => e.type === 'all_providers_context_exceeded');
    expect(allCtxExceededEvents.length).toBe(0);  // 不 emit (mixed cause)
  });
});
