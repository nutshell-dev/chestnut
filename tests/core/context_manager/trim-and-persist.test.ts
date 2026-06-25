import { describe, it, expect, vi } from 'vitest';
import { trimAndPersist, type TriggerKind } from '../../../src/core/context_manager/trim-and-persist.js';
import { CONTEXT_TRIM_ARCHIVED } from '../../../src/core/context_manager/audit-events.js';
import { ContextTrimExhaustedError } from '../../../src/core/context_manager/errors.js';
import type { Message, ToolDefinition } from '../../../src/foundation/llm-provider/types.js';
import type { DialogStore } from '../../../src/foundation/dialog-store/index.js';

const NOW = 1_700_000_000_000;
const RECENT_WINDOW_MS = 86_400_000;

function makeDialogStore(overrides?: {
  archive?: () => Promise<void>;
  save?: (s: { systemPrompt: string; messages: Message[]; toolsForLLM: ToolDefinition[] }) => Promise<void>;
}): DialogStore {
  return {
    archive: vi.fn(overrides?.archive ?? (async () => {})),
    save: vi.fn(overrides?.save ?? (async () => {})),
  } as unknown as DialogStore;
}

function makeAudit(): { write: ReturnType<typeof vi.fn>; events: string[][] } {
  const events: string[][] = [];
  return {
    write: vi.fn((event: string, ...details: string[]) => {
      events.push([event, ...details]);
    }),
    events,
  };
}

function baseInputs(overrides?: Partial<Parameters<typeof trimAndPersist>[0]>): Parameters<typeof trimAndPersist>[0] {
  return {
    messages: [{ role: 'user', content: '测'.repeat(500), addedAt: new Date(NOW).toISOString() } as Message],
    systemPrompt: 'sys',
    toolsForLLM: [],
    contextWindow: 2_000,
    recentWindowMs: RECENT_WINDOW_MS,
    targetRatio: 0.75,
    previewBytes: 100,
    filterSubtypes: new Set(),
    dialogStore: makeDialogStore(),
    audit: makeAudit(),
    triggerKind: 'reactive_overflow' as TriggerKind,
    now: NOW,
    ...overrides,
  };
}

describe('trimAndPersist', () => {
  it('1. 触底裁基础：trim + archive + save 全调', async () => {
    const store = makeDialogStore();
    const inputs = baseInputs({ dialogStore: store });
    const result = await trimAndPersist(inputs);

    expect(store.archive).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(result.archived).toBe(true);
    expect(result.newMessages).toEqual((store.save as ReturnType<typeof vi.fn>).mock.calls[0][0].messages);
  });

  it('2. trimV2 throw ContextTrimExhaustedError → archive + save 不调', async () => {
    const store = makeDialogStore();
    const inputs = baseInputs({
      dialogStore: store,
      contextWindow: 10,
      targetRatio: 0.75,
    });
    await expect(trimAndPersist(inputs)).rejects.toThrow(ContextTrimExhaustedError);
    expect(store.archive).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('3. archive 失败 → save 不调、错上抛', async () => {
    const archiveErr = new Error('disk full');
    const store = makeDialogStore({
      archive: async () => { throw archiveErr; },
    });
    const inputs = baseInputs({ dialogStore: store });
    await expect(trimAndPersist(inputs)).rejects.toThrow(archiveErr);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('4. save 失败 → 错上抛（archive 已生效）', async () => {
    const saveErr = new Error('write failed');
    const store = makeDialogStore({
      save: async () => { throw saveErr; },
    });
    const inputs = baseInputs({ dialogStore: store });
    await expect(trimAndPersist(inputs)).rejects.toThrow(saveErr);
    expect(store.archive).toHaveBeenCalledTimes(1);
  });

  it('5. trigger_kind = reactive_overflow → audit ARCHIVED 含 reactive', async () => {
    const audit = makeAudit();
    const inputs = baseInputs({ audit, triggerKind: 'reactive_overflow' });
    await trimAndPersist(inputs);
    const archived = audit.events.find(e => e[0] === CONTEXT_TRIM_ARCHIVED);
    expect(archived).toBeDefined();
    expect(archived).toContain('trigger_kind=reactive_overflow');
  });

  it('6. trigger_kind = proactive_cache_idle', async () => {
    const audit = makeAudit();
    const inputs = baseInputs({ audit, triggerKind: 'proactive_cache_idle' });
    await trimAndPersist(inputs);
    const archived = audit.events.find(e => e[0] === CONTEXT_TRIM_ARCHIVED);
    expect(archived).toContain('trigger_kind=proactive_cache_idle');
  });

  it('7. targetMessagesTokens 算法 = window × 0.75 - sysTokens - toolsTokens', async () => {
    const audit = makeAudit();
    const inputs = baseInputs({
      audit,
      contextWindow: 2_000,
      systemPrompt: 'a'.repeat(100),
      toolsForLLM: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', origin: 'system', systemSubtype: 'task_result', content: '[system message] ' + '测'.repeat(500), addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString() }],
    });
    // 100 ASCII chars ≈ 25 tokens; tool ≈ small; target ≈ 1500 - 25 - few = 1470+
    // With 500 Chinese chars system message outside 24h (~1004 tokens), should trigger trim and fit.
    const result = await trimAndPersist(inputs);
    expect(result.estimatedTokensAfter).toBeLessThan(1500);
    const started = audit.events.find(e => e[0] === 'context_trim_started');
    expect(started).toBeDefined();
    const targetArg = started!.find(d => d.startsWith('target='));
    expect(targetArg).toBeDefined();
    const target = Number(targetArg!.split('=')[1]);
    expect(target).toBeGreaterThan(1_400);
    expect(target).toBeLessThan(1_500);
  });

  it('8. now 注入 → newMessages 内 P4 摘要 addedAt 跟随 now', async () => {
    const inputs = baseInputs({
      contextWindow: 1_000,
      messages: [
        { role: 'user', origin: 'system', systemSubtype: 'task_result', content: '[system message] ' + '测'.repeat(500), addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString() },
        { role: 'user', content: '最近一条', addedAt: new Date(NOW).toISOString() },
      ],
      now: NOW,
    });
    const result = await trimAndPersist(inputs);
    const summary = result.newMessages.find(m => m.systemSubtype === 'context_trim_summary');
    expect(summary).toBeDefined();
    expect(summary!.addedAt).toBe(new Date(NOW).toISOString());
  });
});
