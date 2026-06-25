import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Message } from '../../../src/foundation/llm-provider/types.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import {
  maybeTrimProactive,
  type MaybeTrimProactiveInputs,
} from '../../../src/core/context_manager/maybe-trim-proactive.js';
import * as tokenEstimator from '../../../src/foundation/llm-provider/token-estimator.js';
import * as trimAndPersistModule from '../../../src/core/context_manager/trim-and-persist.js';
import { CACHE_TTL_MS } from '../../../src/core/context_manager/constants.js';

const NOW = 1_700_000_000_000;

function makeDialogStore(): DialogStore {
  return {
    archive: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
  } as unknown as DialogStore;
}

function makeAudit(): { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() };
}

function makeInputs(overrides?: Partial<MaybeTrimProactiveInputs>): MaybeTrimProactiveInputs {
  return {
    messages: [{ role: 'user', content: 'hello', addedAt: new Date(NOW).toISOString() } as Message],
    systemPrompt: 'sys',
    toolsForLLM: [],
    contextWindow: 2_000,
    lastLLMCallAt: NOW - CACHE_TTL_MS - 1,
    filterSubtypes: new Set(),
    dialogStore: makeDialogStore(),
    audit: makeAudit(),
    now: NOW,
    ...overrides,
  };
}

describe('maybeTrimProactive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. 首次不触发（lastLLMCallAt = 0）', async () => {
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    const result = await maybeTrimProactive(makeInputs({ lastLLMCallAt: 0 }));
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('2. 缓存仍有效（idle ≤ CACHE_TTL_MS）不触发', async () => {
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    const result = await maybeTrimProactive(
      makeInputs({ lastLLMCallAt: NOW - CACHE_TTL_MS + 1 }),
    );
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('3. idle 恰等于 CACHE_TTL_MS 不触发', async () => {
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    const result = await maybeTrimProactive(makeInputs({ lastLLMCallAt: NOW - CACHE_TTL_MS }));
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('4. idle > TTL 但占用率 < 0.75 不触发', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(1_499); // target = 1500
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    const result = await maybeTrimProactive(makeInputs({ contextWindow: 2_000 }));
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('5. idle > TTL + 占用率 ≥ 0.75 触发', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    const result = await maybeTrimProactive(makeInputs({ contextWindow: 2_000 }));
    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('6. 触发时 triggerKind = proactive_cache_idle', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    await maybeTrimProactive(makeInputs({ contextWindow: 2_000 }));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ triggerKind: 'proactive_cache_idle' }),
    );
  });

  it('7. now 注入被使用', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    const customNow = NOW + 123_456;
    await maybeTrimProactive(
      makeInputs({
        contextWindow: 2_000,
        now: customNow,
        lastLLMCallAt: customNow - CACHE_TTL_MS - 1,
      }),
    );
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ now: customNow }));
  });

  it('8. trimAndPersist throw ContextTrimExhaustedError 上抛', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const err = new Error('exhausted');
    vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockRejectedValue(err);
    await expect(maybeTrimProactive(makeInputs({ contextWindow: 2_000 }))).rejects.toThrow(err);
  });

  it('9. 占用率恰等于 target 触发（≥）', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(1_500); // target = 1500
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    const result = await maybeTrimProactive(makeInputs({ contextWindow: 2_000 }));
    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('10. filterSubtypes 透传给 trimAndPersist', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ newMessages: [], archived: true, estimatedTokensAfter: 0 });
    const filterSubtypes = new Set(['subtypeA']);
    await maybeTrimProactive(makeInputs({ contextWindow: 2_000, filterSubtypes }));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ filterSubtypes }));
  });
});
