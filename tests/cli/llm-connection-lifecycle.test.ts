/**
 * Phase 2134: one-shot CLI probes always close their ephemeral orchestrator.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LLMModelNotFoundError,
  type ProviderConfig,
} from '../../src/foundation/llm-provider/index.js';

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  close: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../src/foundation/llm-orchestrator/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/llm-orchestrator/index.js')>();
  return { ...actual, createLLMOrchestrator: mocks.create };
});

import {
  checkLLMConnectionFor,
  probeLLMConnection,
} from '../../src/cli/llm-connection-check.js';

function providerConfig(): ProviderConfig {
  return {
    name: 'p',
    apiKey: 'k',
    model: 'm',
    temperature: 0.7,
    timeoutMs: 30_000,
    apiFormat: 'openai',
    baseUrl: 'https://api.test.invalid/v1',
  };
}

function snapshot(): Parameters<typeof probeLLMConnection>[0] {
  return {
    config: { primary: providerConfig() },
    identity: 'snapshot-id',
  } as unknown as Parameters<typeof probeLLMConnection>[0];
}

const probes = [
  {
    name: 'probeLLMConnection',
    run: () => probeLLMConnection(snapshot()),
    expectedSuccess: { ok: true, model: 'm', identity: 'snapshot-id' },
  },
  {
    name: 'checkLLMConnectionFor',
    run: () => checkLLMConnectionFor(providerConfig()),
    expectedSuccess: { ok: true, model: 'm' },
  },
] as const;

beforeEach(() => {
  mocks.call.mockReset().mockResolvedValue({ content: [], stop_reason: 'end_turn' });
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.create.mockReset().mockReturnValue({ call: mocks.call, close: mocks.close });
});

describe.each(probes)('$name lifecycle', ({ run, expectedSuccess }) => {
  it('closes exactly once after a successful call', async () => {
    await expect(run()).resolves.toEqual(expectedSuccess);
    expect(mocks.call).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.close.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.call.mock.invocationCallOrder[0],
    );
  });

  it('closes exactly once after a classified call failure', async () => {
    mocks.call.mockRejectedValue(new LLMModelNotFoundError('p', 'm', 'missing'));
    const result = await run();
    expect(result).toMatchObject({ ok: false, errorType: 'model', provider: 'p' });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('closes exactly once after a generic call throw', async () => {
    mocks.call.mockRejectedValue(new Error('call failed'));
    const result = await run();
    expect(result).toMatchObject({ ok: false, errorType: 'unknown', message: 'call failed' });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('exposes a close failure instead of returning probe success', async () => {
    const closeError = new Error('close failed');
    mocks.close.mockRejectedValue(closeError);
    await expect(run()).rejects.toBe(closeError);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('preserves both call and close failures when cleanup also fails', async () => {
    const callError = new Error('call failed');
    const closeError = new Error('close failed');
    mocks.call.mockRejectedValue(callError);
    mocks.close.mockRejectedValue(closeError);

    const rejection = await run().catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([callError, closeError]);
    expect((rejection as AggregateError).cause).toBe(callError);
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
