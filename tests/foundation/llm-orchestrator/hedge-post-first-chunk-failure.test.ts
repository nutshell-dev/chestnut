/**
 * Hedge drain post-first-chunk failure — reverse test for phase 903 B2
 *
 * When primary wins (first chunk) but drain throws mid-stream,
 * breaker.onFailure must be called + audit event emitted + error rethrown.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import { LLMNetworkError } from '../../../src/types/errors.js';
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
    streamErrorAfter?: number; // throw after N chunks
    callResponse?: any;
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

describe('LLMOrchestratorImpl hedge drain post-first-chunk failure (phase 903 B2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls breaker.onFailure + emits audit event + rethrows when drain throws', async () => {
    const drainErr = new LLMNetworkError('primary', new Error('ECONNRESET'));
    const primary = createMockProvider('primary', {
      streamChunks: [
        { type: 'text_delta', delta: 'hello' },
        { type: 'text_delta', delta: ' world' },
      ],
      streamErrorAfter: 1, // throw after yielding 1 chunk (post-first-chunk)
      streamError: drainErr,
    });
    const fallback = createMockProvider('fb1', {
      callResponse: {
        content: [{ type: 'text', text: 'fb response' }],
        stop_reason: 'end_turn',
      },
      callDelayMs: 500,
    });
    const service = createOrchestrator(primary, [fallback]);
    forceBreakerOpen(service, 0, 'transient');
    const events = attachEventSpy(service);

    const breaker = (service as any).breakers[0] as CircuitBreaker;
    const onFailureSpy = vi.spyOn(breaker, 'onFailure');

    const chunks: StreamChunk[] = [];
    let caught: Error | undefined;
    try {
      for await (const c of service.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
        chunks.push(c);
      }
    } catch (e) {
      caught = e as Error;
    }

    // first chunk yielded before drain throws + reset chunk from B.6
    expect(chunks).toEqual([
      { type: 'text_delta', delta: 'hello' },
      { type: 'reset', provider: 'primary' },
    ]);

    // error rethrown
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('ECONNRESET');

    // breaker.onFailure called with the error class
    expect(onFailureSpy).toHaveBeenCalledTimes(1);
    expect(onFailureSpy).toHaveBeenCalledWith('transient');

    // audit event emitted
    const auditEvent = events.find(e => e.type === 'hedge_primary_post_first_chunk_failure');
    expect(auditEvent).toBeDefined();
    expect((auditEvent as any).provider).toBe('primary');
    expect((auditEvent as any).error).toBeDefined();
  });
});
