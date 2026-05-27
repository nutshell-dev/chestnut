/**
 * hedge double-fail primaryIter generator cleanup (phase 984)
 * Reverse test 3项: 双失败 path 显式 cleanup generator / happy drain 不触发
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import { LLMNetworkError } from '../../../src/foundation/llm-orchestrator/errors.js';
import type {
  ProviderAdapter,
  StreamChunk,
  LLMEventSink,
  LLMResponse,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createMockProvider(
  name: string,
  opts: {
    streamChunks?: StreamChunk[];
    streamError?: Error;
    streamDelayMs?: number;
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
    stream: opts.streamChunks || opts.streamError
      ? async function* (streamOpts?: { signal?: AbortSignal }) {
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
    onStreamParseError: undefined,
    onToolArgParseError: undefined,
  };
}

function createOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const noopSink: LLMEventSink = { emit: () => {} };
  const service = new LLMOrchestratorImpl({
    primary: { name: primary.name, apiKey: 'test', model: primary.model },
    fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'test', model: fb.model })),
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

/**
 * Wrap a provider's stream generator so that .return() calls are spyable.
 */
function wrapProviderStreamWithReturnSpy(provider: ProviderAdapter) {
  const returnSpy = vi.fn(async () => ({ done: true as const, value: undefined }));
  if (!provider.stream) return { provider, returnSpy };

  const originalStream = provider.stream.bind(provider);
  provider.stream = function (opts?: { signal?: AbortSignal }) {
    const gen = originalStream(opts);
    const originalReturn = gen.return.bind(gen);
    gen.return = async function (value?: unknown) {
      returnSpy(value);
      return originalReturn(value);
    };
    return gen;
  };

  return { provider, returnSpy };
}

describe('hedge double-fail primaryIter generator cleanup (phase 984)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('A-error → B-error 双失败 → primaryIter.return called', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
    });
    const { provider: primary, returnSpy } = wrapProviderStreamWithReturnSpy(primaryRaw);

    const fb1 = createMockProvider('fb1', {
      callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
      callDelayMs: 50,
    });
    const service = createOrchestrator(primary, [fb1]);
    forceBreakerOpen(service, 0, 'transient');

    await expect(async () => {
      for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
    }).rejects.toThrow();

    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('B-error → A-error 双失败 → primaryIter.return called', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamError: new LLMNetworkError('primary', new Error('ECONNREFUSED')),
      streamDelayMs: 50,
    });
    const { provider: primary, returnSpy } = wrapProviderStreamWithReturnSpy(primaryRaw);

    const fb1 = createMockProvider('fb1', {
      callError: new LLMNetworkError('fb1', new Error('ECONNREFUSED')),
    });
    const service = createOrchestrator(primary, [fb1]);
    forceBreakerOpen(service, 0, 'transient');

    await expect(async () => {
      for await (const _ of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {}
    }).rejects.toThrow();

    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('A 胜 drain → primaryIter.return explicitly called in finally (phase 1374 sub-2)', async () => {
    const primaryRaw = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        { type: 'done', stopReason: 'end_turn' },
      ],
      streamDelayMs: 10,
    });
    const { provider: primary, returnSpy } = wrapProviderStreamWithReturnSpy(primaryRaw);

    const fb1 = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
      callDelayMs: 500,
    });
    const service = createOrchestrator(primary, [fb1]);
    forceBreakerOpen(service, 0, 'transient');

    const chunks: StreamChunk[] = [];
    for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(c);
    }

    expect(chunks.some((c) => c.type === 'text_delta' && c.delta === 'hello')).toBe(true);
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });
});
