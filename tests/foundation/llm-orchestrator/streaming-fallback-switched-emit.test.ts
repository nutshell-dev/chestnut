/**
 * phase 686 Step A: streaming 路径补 fallback_switched emit
 *
 * 反向测试 ≥3 项：
 * - primary 失败 + fallback 成功 → emit fallback_switched { from: primary, to: fallback }
 * - 链式 2 fallback：第一失败、第二也失败、第三成功 → 2 个 fallback_switched
 * - primary 直接成功 → 0 fallback_switched
 */

import { describe, it, expect } from 'vitest';
import { LLMOrchestratorImpl } from '../../../src/foundation/llm-orchestrator/orchestrator.js';
import { CircuitBreaker } from '../../../src/foundation/llm-orchestrator/circuit-breaker.js';
import type {
  ProviderAdapter,
  LLMEventSink,
  LLMEvent,
} from '../../../src/foundation/llm-orchestrator/types.js';

function createMockSink() {
  const emitted: LLMEvent[] = [];
  const sink: LLMEventSink = {
    emit(event: LLMEvent) { emitted.push(event); }
  };
  return { sink, emitted };
}

function alwaysFailingStreamProvider(name: string): ProviderAdapter {
  return {
    name,
    model: `${name}-model`,
    async call() { throw new Error(`${name} call fail`); },
    async *stream() {
      throw new Error(`${name} stream fail`);
    },
  };
}

function successStreamProvider(name: string): ProviderAdapter {
  return {
    name,
    model: `${name}-model`,
    async call() { return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' } as any; },
    async *stream() {
      yield { type: 'text_delta', delta: 'hello' };
      yield { type: 'done' };
    },
  };
}

function buildOrchestrator(primary: ProviderAdapter, fallbacks: ProviderAdapter[]) {
  const { sink, emitted } = createMockSink();
  const orchestrator = new LLMOrchestratorImpl({
    primary: { name: primary.name, apiKey: 'k', model: primary.model, apiFormat: 'anthropic' as const },
    fallbacks: fallbacks.map(fb => ({ name: fb.name, apiKey: 'k', model: fb.model, apiFormat: 'anthropic' as const })),
    maxAttempts: 1,
    retryDelayMs: 0,
    events: sink,
  });
  (orchestrator as any).primary = primary;
  (orchestrator as any).fallbacks = fallbacks;
  (orchestrator as any).breakers = [primary, ...fallbacks].map(() => new CircuitBreaker(5, 1000, () => {}));
  return { orchestrator, emitted };
}

async function consume(gen: AsyncIterableIterator<any>): Promise<any[]> {
  const chunks: any[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

describe('phase 686 Step A: streaming fallback_switched emit', () => {
  it('primary 失败 + fallback 成功 → emit 1 fallback_switched (from primary, to fallback)', async () => {
    const primary = alwaysFailingStreamProvider('primary');
    const fallback = successStreamProvider('fallback');
    const { orchestrator, emitted } = buildOrchestrator(primary, [fallback]);

    await consume(orchestrator.stream({}));

    const switches = emitted.filter(e => e.type === 'fallback_switched');
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({
      type: 'fallback_switched',
      from: 'primary',
      to: 'fallback',
    });
  });

  it('链式失败：primary + fb1 失败、fb2 成功 → 1 fallback_switched (from=fb1, to=fb2)', async () => {
    // lazy announce 语义：fallback_switched 仅在「下个 provider 首 chunk 成功 yield」时 emit
    // primary 失败 0 chunk + fb1 失败 0 chunk → fb2 首 chunk 时只 announce (from=fb1, to=fb2)
    // 中间 fb1 的失败由 provider_failed 事件可见、不需独立 switch 行
    const primary = alwaysFailingStreamProvider('primary');
    const fb1 = alwaysFailingStreamProvider('fb1');
    const fb2 = successStreamProvider('fb2');
    const { orchestrator, emitted } = buildOrchestrator(primary, [fb1, fb2]);

    const chunks = await consume(orchestrator.stream({}));

    const switches = emitted.filter(e => e.type === 'fallback_switched');
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ from: 'fb1', to: 'fb2' });

    // provider_failed yield 在 chunk 流中保留 primary + fb1 失败可见性
    const failedProviders = chunks.filter(c => c.type === 'provider_failed').map(c => c.provider).sort();
    expect(failedProviders).toEqual(['fb1', 'primary']);
  });

  it('primary 直接成功 → 0 fallback_switched', async () => {
    const primary = successStreamProvider('primary');
    const fallback = successStreamProvider('fallback');
    const { orchestrator, emitted } = buildOrchestrator(primary, [fallback]);

    await consume(orchestrator.stream({}));

    const switches = emitted.filter(e => e.type === 'fallback_switched');
    expect(switches).toHaveLength(0);
  });

  it('mid-stream fail then fallback succeeds → emit 1 fallback_switched', async () => {
    const midFailPrimary: ProviderAdapter = {
      name: 'primary',
      model: 'primary-model',
      async call() { return { content: [], stop_reason: 'end_turn' } as any; },
      async *stream() {
        yield { type: 'text_delta', delta: 'partial' };
        throw new Error('mid-stream failure');
      },
    };
    const fallback = successStreamProvider('fallback');
    const { orchestrator, emitted } = buildOrchestrator(midFailPrimary, [fallback]);

    await consume(orchestrator.stream({}));

    const switches = emitted.filter(e => e.type === 'fallback_switched');
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ from: 'primary', to: 'fallback' });
  });
});
