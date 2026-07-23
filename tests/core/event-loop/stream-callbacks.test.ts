import { describe, it, expect, vi } from 'vitest';
import { createStreamCallbacks } from '../../../src/core/event-loop/stream-callbacks.js';
import type { StreamLog } from '../../../src/foundation/stream/index.js';
import type { Runtime } from '../../../src/core/runtime/index.js';

function makeSink(): StreamLog & { events: unknown[] } {
  const events: unknown[] = [];
  return {
    events,
    write: (event: unknown) => events.push(event),
  };
}

function makeRuntime(traceId?: string): Pick<Runtime, 'getCurrentTraceId'> {
  return {
    getCurrentTraceId: () => traceId ?? null,
  };
}

describe('stream-callbacks (phase 1176 Step C)', () => {
  it('onProviderFailed writes exactly one provider_failed event and no fabricated provider_attempt_failed', () => {
    const sink = makeSink();
    const runtime = makeRuntime('trace-1176');
    const callbacks = createStreamCallbacks(sink, runtime as Runtime);

    callbacks.onProviderFailed({
      provider: 'custom-anthropic',
      model: 'model-x',
      error: '401 auth failed',
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toEqual({
      ts: expect.any(Number),
      type: 'provider_failed',
      provider: 'custom-anthropic',
      model: 'model-x',
      error: '401 auth failed',
      trace_id: 'trace-1176',
    });
  });

  it('does not fabricate provider_attempt_failed even for permanent-looking errors', () => {
    const sink = makeSink();
    const runtime = makeRuntime();
    const callbacks = createStreamCallbacks(sink, runtime as Runtime);

    const permanentErrors = [
      'quota exceeded',
      'model not found',
      '403 forbidden',
      'credit insufficient',
      'deprecated model',
    ];

    for (const error of permanentErrors) {
      callbacks.onProviderFailed({
        provider: 'openai',
        model: 'gpt-4',
        error,
      });
    }

    const providerFailedCount = sink.events.filter((e) => (e as Record<string, unknown>).type === 'provider_failed').length;
    const attemptFailedCount = sink.events.filter((e) => (e as Record<string, unknown>).type === 'provider_attempt_failed').length;

    expect(providerFailedCount).toBe(permanentErrors.length);
    expect(attemptFailedCount).toBe(0);
  });
});
