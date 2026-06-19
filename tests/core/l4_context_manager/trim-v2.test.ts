import { describe, it, expect, vi } from 'vitest';
import { trimV2, type TrimV2Options, type AuditWriter } from '../../../src/core/l4_context_manager/trim-v2.js';
import { CONTEXT_TRIM_EXHAUSTED } from '../../../src/core/l4_context_manager/audit-events.js';
import { ContextTrimExhaustedError } from '../../../src/core/l4_context_manager/errors.js';
import { estimateMessagesTokens } from '../../../src/foundation/llm-provider/token-estimator.js';
import type { Message } from '../../../src/foundation/llm-provider/types.js';

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
const RECENT_WINDOW_MS = 86_400_000;
const PREVIEW_BYTES = 100;

function makeTextMsg(text: string, opts?: Partial<Message>): Message {
  return {
    role: 'user',
    content: text,
    addedAt: new Date(NOW).toISOString(),
    ...opts,
  };
}

function makeSystemMsg(text: string, subtype: string, addedAtMs: number): Message {
  return {
    role: 'user',
    content: text,
    origin: 'system',
    systemSubtype: subtype,
    addedAt: new Date(addedAtMs).toISOString(),
  };
}

function baseOpts(overrides?: Partial<TrimV2Options>): TrimV2Options {
  return {
    recentWindowMs: RECENT_WINDOW_MS,
    previewBytes: PREVIEW_BYTES,
    filterSubtypes: new Set(['claw_outbox_summary', 'heartbeat', 'claw_inactivity']),
    targetMessagesTokens: 1_000,
    now: NOW,
    ...overrides,
  };
}

describe('trimV2', () => {
  it('1. 全消息在 24h 内 → 不裁', () => {
    const messages: Message[] = [
      makeTextMsg('a'.repeat(200)),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], addedAt: new Date(NOW).toISOString() },
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 10_000 }));
    expect(result.newMessages).toHaveLength(2);
    expect(result.droppedSystemMessages).toBe(0);
    expect(result.summaryMessageInjected).toBe(false);
    expect(result.estimatedTokensAfter).toBe(estimateMessagesTokens(messages));
  });

  it('2. 全 system 消息 24h 外且 filterSubtypes 命中 → 全删 + P4 摘要', () => {
    const messages: Message[] = [
      makeSystemMsg('[system message] 未读 1 ' + '测'.repeat(500), 'claw_outbox_summary', NOW - RECENT_WINDOW_MS - 1),
      makeSystemMsg('[system message] 未读 2 ' + '测'.repeat(500), 'claw_outbox_summary', NOW - RECENT_WINDOW_MS - 2),
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 1_000 }));
    expect(result.newMessages).toHaveLength(1);
    expect(result.droppedSystemMessages).toBe(2);
    expect(result.summaryMessageInjected).toBe(true);
    const summary = result.newMessages[0];
    expect(summary.systemSubtype).toBe('context_trim_summary');
    expect(summary.content).toContain('claw_outbox_summary × 2');
  });

  it('3. tool_result 折叠基础 → content 替换且 id 配对在', () => {
    const longResult = '测'.repeat(500);
    const toolUseId = 'call_1_abc';
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'read', input: { path: '/x' } }],
        addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString(),
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: longResult }],
        addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString(),
      },
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 400 }));
    expect(result.collapsedToolResults).toBe(1);
    const tr = (result.newMessages[1].content as [{ type: 'tool_result'; content: string }])[0];
    expect(tr.content).toContain('<...>');
    expect(tr.content).toContain('tool_use_id=call_1_abc');
    expect(tr.content).toContain('1500 bytes');
  });

  it('4. tool_use 入参长 string 字段折叠', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_2_abc',
          name: 'write',
          input: { path: '/short', content: '测'.repeat(500) },
        }],
        addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString(),
      },
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 400 }));
    expect(result.collapsedToolUseFields).toBe(1);
    const tu = (result.newMessages[0].content as [{ type: 'tool_use'; input: Record<string, unknown> }])[0];
    expect(tu.input.path).toBe('/short');
    expect(tu.input.content).toContain('<...>');
    expect(tu.input.content).toContain('1500 bytes');
  });

  it('5. P2 重复检测：同 tool + 同入参旧 result 被 superseded', () => {
    const id1 = 'call_3_old';
    const id2 = 'call_3_new';
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: id1, name: 'read', input: { path: '/same' } }],
        addedAt: new Date(NOW - RECENT_WINDOW_MS - 100).toISOString(),
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id1, content: 'old result ' + '测'.repeat(500) }],
        addedAt: new Date(NOW - RECENT_WINDOW_MS - 99).toISOString(),
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: id2, name: 'read', input: { path: '/same' } }],
        addedAt: new Date(NOW - RECENT_WINDOW_MS - 50).toISOString(),
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id2, content: 'new result ' + '测'.repeat(500) }],
        addedAt: new Date(NOW - RECENT_WINDOW_MS - 49).toISOString(),
      },
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 500 }));
    expect(result.supersededRedundantResults).toBe(1);
    const old = (result.newMessages[1].content as [{ type: 'tool_result'; content: string }])[0];
    const newest = (result.newMessages[3].content as [{ type: 'tool_result'; content: string }])[0];
    expect(old.content).toContain('superseded');
    expect(newest.content).toContain('<...>');
  });

  it('6. 折叠后变大跳过（content 短）', () => {
    const short = 's'.repeat(50);
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_4', content: short }],
        addedAt: new Date(NOW - RECENT_WINDOW_MS - 1).toISOString(),
      },
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 200 }));
    expect(result.collapsedToolResults).toBe(0);
    const tr = (result.newMessages[0].content as [{ type: 'tool_result'; content: string }])[0];
    expect(tr.content).toBe(short);
  });

  it('7. trimmed 元数据累计', () => {
    const preTrimmed: Message = {
      ...makeSystemMsg('[system message] ' + '测'.repeat(500), 'task_result', NOW - RECENT_WINDOW_MS - 1),
      trimmed: {
        trimmedAt: new Date(NOW - 10).toISOString(),
        originalContentBytes: 100,
        timesTrimmed: 1,
      },
    };
    const result = trimV2([preTrimmed], baseOpts({ targetMessagesTokens: 400 }));
    const trimmed = result.newMessages[0].trimmed!;
    expect(trimmed.trimmedAt).toBe(preTrimmed.trimmed!.trimmedAt);
    expect(trimmed.timesTrimmed).toBe(2);
    expect(trimmed.originalContentBytes).toBeGreaterThan(preTrimmed.trimmed!.originalContentBytes);
  });

  it('8. 24h 边界精确', () => {
    const threshold = NOW - RECENT_WINDOW_MS;
    const justOlder = makeSystemMsg('[system message] ' + '测'.repeat(500), 'task_result', threshold - 1);
    const justNewer = makeTextMsg('newer', { addedAt: new Date(threshold + 1).toISOString() });
    const result = trimV2([justOlder, justNewer], baseOpts({ targetMessagesTokens: 400 }));
    expect(result.newMessages).toHaveLength(3); // collapsed older + summary + newer
    expect(result.newMessages[1].systemSubtype).toBe('context_trim_summary');
    expect(result.newMessages[2].content).toBe('newer');
  });

  it('9. 老 dialog 无 addedAt → 保守归 24h 内', () => {
    const oldDialog: Message[] = [
      makeTextMsg('no addedAt', { addedAt: undefined }),
    ];
    const result = trimV2(oldDialog, baseOpts({ targetMessagesTokens: 200 }));
    expect(result.newMessages).toHaveLength(1);
    expect(result.summaryMessageInjected).toBe(false);
  });

  it('10. filterSubtypes 命中 140 次 → 全删且摘要正确', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 140; i++) {
      messages.push(makeSystemMsg(`summary ${i} ${'x'.repeat(200)}`, 'claw_outbox_summary', NOW - RECENT_WINDOW_MS - i));
    }
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 300 }));
    expect(result.droppedSystemMessages).toBe(140);
    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0].content).toContain('claw_outbox_summary × 140');
  });

  it('11. 高价值 systemSubtype → 头部预览 + 折叠（不删整 message）', () => {
    const messages: Message[] = [
      makeSystemMsg('[system message] ' + '测'.repeat(500), 'task_result', NOW - RECENT_WINDOW_MS - 1),
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 400 }));
    expect(result.droppedSystemMessages).toBe(0);
    expect(result.newMessages).toHaveLength(2);
    expect(result.newMessages[0].content).toContain('[system message]');
    expect(result.newMessages[0].content).toContain('<...>');
    expect((result.newMessages[0].content as string).length).toBeLessThan(('测'.repeat(500)).length);
  });

  it('12. ContextTrimExhaustedError 抛', () => {
    const audit = { write: vi.fn() } satisfies AuditWriter;
    const huge = makeTextMsg('测'.repeat(500));
    expect(() => trimV2([huge], baseOpts({ targetMessagesTokens: 10, audit }))).toThrow(ContextTrimExhaustedError);
    expect(audit.write).toHaveBeenCalledWith(
      CONTEXT_TRIM_EXHAUSTED,
      expect.stringMatching(/^before=/),
      expect.stringMatching(/^after=/),
      expect.stringMatching(/^target=/),
    );
  });

  it('13. 空 messages 数组 → metrics 全 0', () => {
    const result = trimV2([], baseOpts());
    expect(result.newMessages).toEqual([]);
    expect(result.droppedSystemMessages).toBe(0);
    expect(result.collapsedToolResults).toBe(0);
    expect(result.collapsedToolUseFields).toBe(0);
    expect(result.supersededRedundantResults).toBe(0);
    expect(result.summaryMessageInjected).toBe(false);
    expect(result.estimatedTokensAfter).toBe(0);
  });
});
