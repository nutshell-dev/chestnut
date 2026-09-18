import { describe, it, expect, vi, afterEach } from 'vitest';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';
import {
  maybeTrimProactive,
  type MaybeTrimProactiveInputs,
} from '../../../src/core/context_manager/maybe-trim-proactive.js';
import * as tokenEstimator from '../../../src/foundation/llm-provider/token-estimator.js';
import * as trimAndPersistModule from '../../../src/core/context_manager/trim-and-persist.js';
import {
  CONTEXT_TRIM_RECENT_WINDOW_MS,
  CONTEXT_TRIM_PREVIEW_BYTES,
  CONTEXT_TRIM_TARGET_RATIO,
  REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
} from '../../../src/core/context_manager/constants.js';

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
    cacheExpired: true,
    policy: {
      recentWindowMs: CONTEXT_TRIM_RECENT_WINDOW_MS,
      previewBytes: CONTEXT_TRIM_PREVIEW_BYTES,
      targetRatio: CONTEXT_TRIM_TARGET_RATIO,
      floorRatio: REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
    },
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

  it('1. 缓存未失效（cacheExpired = false，含首 turn 语义）不触发', async () => {
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ status: 'target_reached', before: 0, after: 0, newMessages: [], archived: true });
    const result = await maybeTrimProactive(makeInputs({ cacheExpired: false }));
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('2. idle > TTL 但占用率 < 0.75 不触发', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(1_499); // target = 1500
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ status: 'target_reached', before: 0, after: 0, newMessages: [], archived: true });
    const result = await maybeTrimProactive(makeInputs({ contextWindow: 2_000 }));
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('3. idle > TTL + 占用率 ≥ 0.75 触发', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ status: 'target_reached', before: 0, after: 0, newMessages: [], archived: true });
    const result = await maybeTrimProactive(makeInputs({ contextWindow: 2_000 }));
    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('4. 触发时 triggerKind = proactive_cache_idle', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ status: 'target_reached', before: 0, after: 0, newMessages: [], archived: true });
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
      .mockResolvedValue({ status: 'target_reached', before: 0, after: 0, newMessages: [], archived: true });
    const customNow = NOW + 123_456;
    await maybeTrimProactive(
      makeInputs({
        contextWindow: 2_000,
        now: customNow,
      }),
    );
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ now: customNow }));
  });

  it('6. trimAndPersist throw 上抛', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const err = new Error('exhausted');
    vi.spyOn(trimAndPersistModule, 'trimAndPersist').mockRejectedValue(err);
    await expect(maybeTrimProactive(makeInputs({ contextWindow: 2_000 }))).rejects.toThrow(err);
  });

  it('7. 占用率恰等于 target 触发（≥）', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(1_500); // target = 1500
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ status: 'target_reached', before: 0, after: 0, newMessages: [], archived: true });
    const result = await maybeTrimProactive(makeInputs({ contextWindow: 2_000 }));
    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('8. proactive policy 透传', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(2_000);
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ status: 'target_reached', before: 0, after: 0, newMessages: [], archived: true });
    await maybeTrimProactive(makeInputs({ contextWindow: 2_000 }));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        recentWindowMs: CONTEXT_TRIM_RECENT_WINDOW_MS,
        previewBytes: CONTEXT_TRIM_PREVIEW_BYTES,
        policy: expect.objectContaining({ kind: 'proactive', targetCompleteTokens: 1_500 }),
      }),
    );
  });

  it('9. policy.targetRatio 注入覆盖生效（CM-D1）', async () => {
    vi.spyOn(tokenEstimator, 'estimateTextTokens').mockReturnValue(0);
    vi.spyOn(tokenEstimator, 'estimateToolsTokens').mockReturnValue(0);
    // 默认 ratio 0.75 → target 1500（不触发）；注入 0.5 → target 1000（触发）
    vi.spyOn(tokenEstimator, 'estimateMessagesTokens').mockReturnValue(1_200);
    const spy = vi
      .spyOn(trimAndPersistModule, 'trimAndPersist')
      .mockResolvedValue({ status: 'target_reached', before: 0, after: 0, newMessages: [], archived: true });
    const policy = {
      recentWindowMs: CONTEXT_TRIM_RECENT_WINDOW_MS,
      previewBytes: CONTEXT_TRIM_PREVIEW_BYTES,
      targetRatio: 0.5,
      floorRatio: REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
    };
    const result = await maybeTrimProactive(makeInputs({ contextWindow: 2_000, policy }));
    expect(result).not.toBeNull();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({ kind: 'proactive', targetCompleteTokens: 1_000 }),
      }),
    );
  });
});
