import { describe, expect, it, vi } from 'vitest';
import { trimV2, buildProactiveTrimPolicy } from '../../../src/core/context_manager/trim-v2.js';
import { trimAndPersist } from '../../../src/core/context_manager/trim-and-persist.js';
import { ContextInputMeasurementError } from '../../../src/core/context_manager/errors.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';

const msg = (content: string, addedAt = new Date().toISOString()): Message => ({ role: 'user', origin: 'user', content, addedAt });
const audit = { write: vi.fn() };

describe('complete input measurement', () => {
  it('remeasures each full candidate instead of subtracting per-turn estimates', () => {
    const calls: Message[][] = [];
    const now = Date.now();
    const result = trimV2([
      msg('old', new Date(now - 2 * 86_400_000).toISOString()),
      { role: 'assistant', content: [{ type: 'text', text: 'old assistant' }], addedAt: new Date(now - 2 * 86_400_000).toISOString() },
      msg('new', new Date(now).toISOString()),
    ], {
      recentWindowMs: 86_400_000,
      previewBytes: 10,
      policy: buildProactiveTrimPolicy(10),
      now,
      audit,
      measureComplete: messages => {
        calls.push([...messages]);
        return { kind: 'counted', tokens: messages.some(message => message.role === 'assistant') ? 100 : 5, method: 'deepseek-v41-template' };
      },
    });
    expect(result.outcome.after).toBe(5);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('unavailable measurement stops before archive/save', async () => {
    const archive = vi.fn(async () => {});
    const save = vi.fn(async () => ({ assignedBlockIds: [] }));
    await expect(trimAndPersist({
      messages: [msg('large')],
      systemPrompt: '',
      toolsForLLM: [],
      contextWindow: 100,
      recentWindowMs: 86_400_000,
      previewBytes: 10,
      dialogStore: { archive, save } as never,
      audit,
      triggerKind: 'reactive_overflow',
      policy: buildProactiveTrimPolicy(10),
      measureComplete: () => ({ kind: 'unavailable', reason: 'asset_missing' }),
    })).rejects.toBeInstanceOf(ContextInputMeasurementError);
    expect(archive).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
