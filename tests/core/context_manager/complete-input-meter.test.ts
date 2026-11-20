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
      { role: 'assistant', content: [
        { type: 'text', text: 'old assistant' },
        { type: 'tool_use', id: 'send-old', name: 'send', input: { content: 'keep' } },
      ], addedAt: new Date(now - 2 * 86_400_000).toISOString() },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'send-old', content: 'sent' }], addedAt: new Date(now - 2 * 86_400_000).toISOString() },
      msg('new', new Date(now).toISOString()),
    ], {
      recentWindowMs: 86_400_000,
      previewBytes: 10,
      policy: buildProactiveTrimPolicy(10),
      now,
      audit,
      measureComplete: messages => {
        calls.push([...messages]);
        return { kind: 'estimated', tokens: messages.some(message => Array.isArray(message.content)
          && message.content.some(block => block.type === 'text')) ? 100 : 5, method: 'deepseek-v41-text', reason: 'test' };
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


it('Phase 2149: summary candidate measurement unavailable remains a typed error', () => {
  const now = Date.now();
  const oldSystem: Message = {
    role: 'user', origin: 'system', systemSubtype: 'task_result',
    content: `[system message] ${'测'.repeat(500)}`,
    addedAt: new Date(now - 2 * 86_400_000).toISOString(),
  };
  const messages = [oldSystem, msg('anchor', new Date(now).toISOString())];

  expect(() => trimV2(messages, {
    recentWindowMs: 86_400_000,
    previewBytes: 100,
    fixedTokens: 0,
    policy: buildProactiveTrimPolicy(100),
    now,
    audit,
    measureComplete: candidate => candidate.some(message => message.systemSubtype === 'context_trim_summary')
      ? { kind: 'unavailable', reason: 'summary_measurement_failed' }
      : {
          kind: 'estimated',
          tokens: candidate.some(message => typeof message.content === 'string' && message.content.includes('<...>')) ? 10 : 100,
          method: 'deepseek-v41-text', reason: 'test',
        },
  })).toThrowError(ContextInputMeasurementError);
});
