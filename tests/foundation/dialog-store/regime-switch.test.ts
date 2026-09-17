/**
 * Phase 918 Step B: regime-switch extractLastTurn behavior
 */

import { describe, it, expect, vi } from 'vitest';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { DialogSessionLifecycle } from '../../../src/foundation/dialog-store/index.js';
import {
  extractLastTurn,
  performRegimeSwitch,
} from '../../../src/foundation/dialog-store/regime-switch.js';

describe('extractLastTurn (phase 918)', () => {
  it('returns messages from the last genuine user input, skipping pure tool_result user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'genuine input' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'r' }] },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited[0].role).toBe('user');
    expect(inherited[0].content).toBe('genuine input');
    expect(inherited).toHaveLength(3);
  });

  it('skips multiple trailing pure tool_result user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'r1' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'r2' }] },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited[0].content).toBe('first');
    expect(inherited).toHaveLength(5);
  });

  it('phase 919: skips user messages that mix tool_result with text', () => {
    const mixedContent: Message['content'] = [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'r' },
      { type: 'text', text: 'follow-up' },
    ];
    const messages: Message[] = [
      { role: 'user', content: 'genuine' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: {} }] },
      { role: 'user', content: mixedContent },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited[0].role).toBe('user');
    expect(inherited[0].content).toBe('genuine');
    expect(inherited).toHaveLength(3);
  });

  it('falls back to all messages when there is no genuine user input', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'hi' },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited).toEqual(messages);
  });

  it('returns all messages when the only user message is a plain string', () => {
    const messages: Message[] = [
      { role: 'user', content: 'plain' },
    ];
    const inherited = extractLastTurn(messages);
    expect(inherited).toEqual(messages);
  });
});

describe('performRegimeSwitch dialog repair', () => {
  it('persists a synthetic result for a trailing unpaired tool_use', async () => {
    const messages: Message[] = [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'old_tool', input: {} }],
    }];
    const currentStore = {
      load: vi.fn().mockResolvedValue({
        source: 'current',
        session: {
          version: 2,
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
          systemPrompt: 'old prompt',
          messages,
          toolsForLLM: [],
        },
      }),
      save: vi.fn().mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] }),
      beginTurn: vi.fn(),
      commitTurn: vi.fn(),
      rollbackTurn: vi.fn(),
      archive: vi.fn().mockResolvedValue(undefined),
    } satisfies DialogSessionLifecycle;
    const newStore = {
      ...currentStore,
      save: vi.fn().mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] }),
    } satisfies DialogSessionLifecycle;

    await performRegimeSwitch({
      strategy: 'all',
      newSystemPrompt: 'new prompt',
      currentStore,
      dialogStoreFactory: () => newStore,
      toolsForLLM: [],
      clawDir: '/unused',
      systemFs: {} as FileSystem,
      audit: { write: vi.fn() } as unknown as AuditLog,
      auditEvents: {
        REGIME_SWITCH: 'regime_switch',
        REGIME_SWITCH_COMMITTED: 'regime_switch_committed',
        REGIME_SWITCH_FAILED: 'regime_switch_failed',
        REGIME_SWITCH_HARD_FAIL: 'regime_switch_hard_fail',
      },
    });

    expect(newStore.save).toHaveBeenCalledOnce();
    const snapshot = newStore.save.mock.calls[0][0];
    expect(snapshot.messages.at(-1)).toEqual({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu1',
        content: expect.stringContaining("Tool call 'old_tool'"),
        is_error: true,
      }],
    });
  });

  // phase 1850 Step D: post-commit cleanup 是 Runtime 的显式后续动作，
  // performRegimeSwitch 不再持有/调用任何 caller 注入回调（opts 类型层已无该字段）。
  it('phase 1850 Step D: invokes no caller-injected post-commit callback after commit', async () => {
    const currentStore = {
      load: vi.fn().mockResolvedValue({
        source: 'current',
        session: {
          version: 2,
          systemPrompt: 'old prompt',
          messages: [{ role: 'user', content: 'msg1' }],
          toolsForLLM: [],
        },
      }),
      save: vi.fn().mockResolvedValue({ blockIndexPersisted: true, assignedBlockIds: [] }),
      beginTurn: vi.fn(),
      commitTurn: vi.fn(),
      rollbackTurn: vi.fn(),
      archive: vi.fn().mockResolvedValue(undefined),
    } satisfies DialogSessionLifecycle;
    const newStore = { ...currentStore } satisfies DialogSessionLifecycle;

    const strayCallback = vi.fn().mockResolvedValue(undefined);
    // 历史 caller 若仍携带 onSwitchComplete 字段（类型层已拒、运行时亦不得被调用）
    const optsWithStrayCallback = {
      strategy: 'all',
      newSystemPrompt: 'new prompt',
      currentStore,
      dialogStoreFactory: () => newStore,
      toolsForLLM: [],
      clawDir: '/unused',
      systemFs: {} as FileSystem,
      audit: { write: vi.fn() } as unknown as AuditLog,
      auditEvents: {
        REGIME_SWITCH: 'regime_switch',
        REGIME_SWITCH_COMMITTED: 'regime_switch_committed',
        REGIME_SWITCH_FAILED: 'regime_switch_failed',
        REGIME_SWITCH_HARD_FAIL: 'regime_switch_hard_fail',
      },
      onSwitchComplete: strayCallback,
    } as unknown as Parameters<typeof performRegimeSwitch>[0];

    const result = await performRegimeSwitch(optsWithStrayCallback);

    expect(result.newStore).toBe(newStore);
    expect(strayCallback).not.toHaveBeenCalled();
  });
});
