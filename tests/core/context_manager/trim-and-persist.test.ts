import { describe, it, expect, vi } from 'vitest';
import { trimAndPersist, type TriggerKind } from '../../../src/core/context_manager/trim-and-persist.js';
import { CONTEXT_TRIM_ARCHIVED } from '../../../src/core/context_manager/audit-events.js';
import { buildProactiveTrimPolicy, buildReactiveTrimPolicy } from '../../../src/core/context_manager/trim-v2.js';
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
    previewBytes: 100,
    filterSubtypes: new Set(),
    dialogStore: makeDialogStore(),
    audit: makeAudit(),
    triggerKind: 'reactive_overflow' as TriggerKind,
    policy: buildReactiveTrimPolicy({ contextWindow: 2_000, explicitMaxTokens: undefined }),
    now: NOW,
    ...overrides,
  };
}

describe('trimAndPersist', () => {
  it('1. 有效下降 → trim + archive + save 全调', async () => {
    const store = makeDialogStore();
    const inputs = baseInputs({
      dialogStore: store,
      contextWindow: 1_000,
      policy: buildReactiveTrimPolicy({ contextWindow: 1_000, explicitMaxTokens: undefined }),
      messages: [
        { role: 'user', origin: 'system', systemSubtype: 'task_result', content: '[system message] ' + '测'.repeat(500), addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString() },
        { role: 'user', content: '最近一条', addedAt: new Date(NOW).toISOString() },
      ],
    });
    const result = await trimAndPersist(inputs);

    expect(store.archive).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(result.archived).toBe(true);
    expect(result.newMessages).toEqual((store.save as ReturnType<typeof vi.fn>).mock.calls[0][0].messages);
  });

  it('2. no_progress → archive + save 不调', async () => {
    const store = makeDialogStore();
    const inputs = baseInputs({
      dialogStore: store,
      contextWindow: 10,
      policy: buildReactiveTrimPolicy({ contextWindow: 10, explicitMaxTokens: undefined }),
    });
    const result = await trimAndPersist(inputs);
    expect(store.archive).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(result.archived).toBe(false);
    expect(result.status).toBe('policy_conflict');
  });

  it('3. archive 失败 → save 不调、错上抛', async () => {
    const archiveErr = new Error('disk full');
    const store = makeDialogStore({
      archive: async () => { throw archiveErr; },
    });
    const inputs = baseInputs({
      dialogStore: store,
      contextWindow: 1_000,
      policy: buildReactiveTrimPolicy({ contextWindow: 1_000, explicitMaxTokens: undefined }),
      messages: [
        { role: 'user', origin: 'system', systemSubtype: 'task_result', content: '[system message] ' + '测'.repeat(500), addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString() },
        { role: 'user', content: '最近一条', addedAt: new Date(NOW).toISOString() },
      ],
    });
    await expect(trimAndPersist(inputs)).rejects.toThrow(archiveErr);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('4. save 失败 → 错上抛（archive 已生效）', async () => {
    const saveErr = new Error('write failed');
    const store = makeDialogStore({
      save: async () => { throw saveErr; },
    });
    const inputs = baseInputs({
      dialogStore: store,
      contextWindow: 1_000,
      policy: buildReactiveTrimPolicy({ contextWindow: 1_000, explicitMaxTokens: undefined }),
      messages: [
        { role: 'user', origin: 'system', systemSubtype: 'task_result', content: '[system message] ' + '测'.repeat(500), addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString() },
        { role: 'user', content: '最近一条', addedAt: new Date(NOW).toISOString() },
      ],
    });
    await expect(trimAndPersist(inputs)).rejects.toThrow(saveErr);
    expect(store.archive).toHaveBeenCalledTimes(1);
  });

  it('5. trigger_kind = reactive_overflow → audit ARCHIVED 含 reactive', async () => {
    const audit = makeAudit();
    const inputs = baseInputs({
      audit,
      triggerKind: 'reactive_overflow',
      contextWindow: 1_000,
      policy: buildReactiveTrimPolicy({ contextWindow: 1_000, explicitMaxTokens: undefined }),
      messages: [
        { role: 'user', origin: 'system', systemSubtype: 'task_result', content: '[system message] ' + '测'.repeat(500), addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString() },
        { role: 'user', content: '最近一条', addedAt: new Date(NOW).toISOString() },
      ],
    });
    await trimAndPersist(inputs);
    const archived = audit.events.find(e => e[0] === CONTEXT_TRIM_ARCHIVED);
    expect(archived).toBeDefined();
    expect(archived).toContain('trigger_kind=reactive_overflow');
  });

  it('6. trigger_kind = proactive_cache_idle', async () => {
    const audit = makeAudit();
    const inputs = baseInputs({
      audit,
      triggerKind: 'proactive_cache_idle',
      contextWindow: 1_000,
      policy: buildProactiveTrimPolicy(1_000),
      messages: [
        { role: 'user', origin: 'system', systemSubtype: 'task_result', content: '[system message] ' + '测'.repeat(500), addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString() },
        { role: 'user', content: '最近一条', addedAt: new Date(NOW).toISOString() },
      ],
    });
    await trimAndPersist(inputs);
    const archived = audit.events.find(e => e[0] === CONTEXT_TRIM_ARCHIVED);
    expect(archived).toContain('trigger_kind=proactive_cache_idle');
  });

  it('9. trimV2 空操作 → archive + save 不调、archived=false', async () => {
    const store = makeDialogStore();
    const inputs = baseInputs({ dialogStore: store });
    const result = await trimAndPersist(inputs);

    expect(store.archive).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(result.archived).toBe(false);
    expect(result.newMessages.length).toBe(inputs.messages.length);
  });

  it('7. reactive policy 严格使用显式 maxTokens；undefined=0', async () => {
    const audit = makeAudit();
    const inputs = baseInputs({
      audit,
      contextWindow: 2_000,
      systemPrompt: 'a'.repeat(100),
      toolsForLLM: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      policy: buildReactiveTrimPolicy({ contextWindow: 2_000, explicitMaxTokens: 300 }),
      messages: [{ role: 'user', origin: 'system', systemSubtype: 'task_result', content: '[system message] ' + '测'.repeat(500), addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString() }],
    });
    const result = await trimAndPersist(inputs);
    if (result.status === 'target_reached' || result.status === 'progress') {
      expect(result.after).toBeLessThanOrEqual(1_700); // 2_000 - 300 reserve
    }
  });

  it('8. now 注入 → newMessages 内 P4 摘要 addedAt 跟随 now', async () => {
    const inputs = baseInputs({
      contextWindow: 1_000,
      policy: buildReactiveTrimPolicy({ contextWindow: 1_000, explicitMaxTokens: undefined }),
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
