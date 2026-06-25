import { describe, it, expect, vi } from 'vitest';
import { trimV2, type TrimV2Options, type AuditWriter } from '../../../src/core/context_manager/trim-v2.js';
import { CONTEXT_TRIM_EXHAUSTED } from '../../../src/core/context_manager/audit-events.js';
import { ContextTrimExhaustedError } from '../../../src/core/context_manager/errors.js';
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

/**
 * phase 757: trim-v2 anchor = latest_addedAt
 * 测试模拟「频繁用户 + 有老消息」场景需显式提供一个 NOW 时刻的 user message 当 anchor、
 * 让 threshold = NOW - RW、其余 addedAt = NOW - RW - X 的消息进 olderIdx。
 *
 * 返 [anchor, ...messages] 数组、anchor 在 newerIdx 保留、在 newMessages 末尾出现
 * （olderIdx 处理后 newOlder + summary + newerIdx 顺序）。
 */
function withAnchor(messages: Message[]): Message[] {
  const anchor: Message = makeTextMsg('anchor', { addedAt: new Date(NOW).toISOString() });
  return [...messages, anchor];
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
    const messages: Message[] = withAnchor([
      makeSystemMsg('[system message] 未读 1 ' + '测'.repeat(500), 'claw_outbox_summary', NOW - RECENT_WINDOW_MS - 1),
      makeSystemMsg('[system message] 未读 2 ' + '测'.repeat(500), 'claw_outbox_summary', NOW - RECENT_WINDOW_MS - 2),
    ]);
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 1_000 }));
    // 2 system 被删 + P4 summary + 1 anchor newer message = 2 条 newMessages
    expect(result.newMessages).toHaveLength(2);
    expect(result.droppedSystemMessages).toBe(2);
    expect(result.summaryMessageInjected).toBe(true);
    const summary = result.newMessages[0];
    expect(summary.systemSubtype).toBe('context_trim_summary');
    expect(summary.content).toContain('claw_outbox_summary × 2');
  });

  it('3. tool_result 折叠基础 → content 替换且 id 配对在', () => {
    const longResult = '测'.repeat(500);
    const toolUseId = 'call_1_abc';
    const messages: Message[] = withAnchor([
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
    ]);
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 1_000 }));
    expect(result.collapsedToolResults).toBe(1);
    // newMessages: [assistant tool_use (unchanged), user tool_result (collapsed), summary, anchor]
    const tr = (result.newMessages[1].content as [{ type: 'tool_result'; content: string }])[0];
    expect(tr.content).toContain('<...>');
    expect(tr.content).toContain('tool_use_id=call_1_abc');
    expect(tr.content).toContain('1500 bytes');
  });

  it('4. tool_use 入参长 string 字段折叠', () => {
    const messages: Message[] = withAnchor([
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
    ]);
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 1_000 }));
    expect(result.collapsedToolUseFields).toBe(1);
    // newMessages: [assistant tool_use (collapsed), summary, anchor]
    const tu = (result.newMessages[0].content as [{ type: 'tool_use'; input: Record<string, unknown> }])[0];
    expect(tu.input.path).toBe('/short');
    expect(tu.input.content).toContain('<...>');
    expect(tu.input.content).toContain('1500 bytes');
  });

  it('5. P2 重复检测：同 tool + 同入参旧 result 被 superseded', () => {
    const id1 = 'call_3_old';
    const id2 = 'call_3_new';
    const messages: Message[] = withAnchor([
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
    ]);
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 1_500 }));
    expect(result.supersededRedundantResults).toBe(1);
    // newMessages: [tool_use 1, tool_result 1 (superseded), tool_use 2, tool_result 2 (collapsed), summary, anchor]
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
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 500 }));
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
    const result = trimV2(withAnchor([preTrimmed]), baseOpts({ targetMessagesTokens: 1_000 }));
    // newMessages: [preTrimmed (collapsed + trimmed metadata accumulated), summary, anchor]
    const trimmed = result.newMessages[0].trimmed!;
    expect(trimmed.trimmedAt).toBe(preTrimmed.trimmed!.trimmedAt);
    expect(trimmed.timesTrimmed).toBe(2);
    expect(trimmed.originalContentBytes).toBeGreaterThan(preTrimmed.trimmed!.originalContentBytes);
  });

  it('8. 24h 边界精确 (anchor = max(addedAt) = NOW; threshold = NOW - RW)', () => {
    const threshold = NOW - RECENT_WINDOW_MS;
    const justOlder = makeSystemMsg('[system message] ' + '测'.repeat(500), 'task_result', threshold - 1);
    const justNewer = makeTextMsg('newer', { addedAt: new Date(threshold + 1).toISOString() });
    // 加 NOW anchor 让 latest_addedAt = NOW、threshold = NOW - RW 同测试预期
    const result = trimV2(withAnchor([justOlder, justNewer]), baseOpts({ targetMessagesTokens: 1_000 }));
    // newMessages: [collapsed older, summary, newer, anchor]
    expect(result.newMessages).toHaveLength(4);
    expect(result.newMessages[1].systemSubtype).toBe('context_trim_summary');
    expect(result.newMessages[2].content).toBe('newer');
  });

  it('9. 老 dialog 无 addedAt → 视为 24h 外可裁 (phase 757、不向后兼容、archive 兜底)', () => {
    // phase 757：无 addedAt 走 olderIdx 路径、命中 filterSubtypes 删除验证「24h 外」分类
    const oldDialog: Message[] = [
      { ...makeSystemMsg('[system message] no addedAt ' + '测'.repeat(200), 'claw_outbox_summary', NOW), addedAt: undefined },
    ];
    const result = trimV2(oldDialog, baseOpts({ targetMessagesTokens: 300 }));
    expect(result.summaryMessageInjected).toBe(true);
    expect(result.droppedSystemMessages).toBe(1);
    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0].systemSubtype).toBe('context_trim_summary');
  });

  it('10. filterSubtypes 命中 140 次 → 全删且摘要正确', () => {
    const messages: Message[] = [];
    for (let i = 0; i < 140; i++) {
      messages.push(makeSystemMsg(`summary ${i} ${'x'.repeat(200)}`, 'claw_outbox_summary', NOW - RECENT_WINDOW_MS - i));
    }
    const result = trimV2(withAnchor(messages), baseOpts({ targetMessagesTokens: 1_000 }));
    expect(result.droppedSystemMessages).toBe(140);
    // newMessages: [summary, anchor]
    expect(result.newMessages).toHaveLength(2);
    expect(result.newMessages[0].content).toContain('claw_outbox_summary × 140');
  });

  it('11. 高价值 systemSubtype → 头部预览 + 折叠（不删整 message）', () => {
    const messages: Message[] = withAnchor([
      makeSystemMsg('[system message] ' + '测'.repeat(500), 'task_result', NOW - RECENT_WINDOW_MS - 1),
    ]);
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 1_000 }));
    expect(result.droppedSystemMessages).toBe(0);
    // newMessages: [collapsed system message, summary, anchor]
    expect(result.newMessages).toHaveLength(3);
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

  // ─── phase 757 新增：anchor = latest_addedAt + 无 addedAt 归 24h 外 ───

  it('14. phase 757: 几天没用回来 → anchor = latest_addedAt、上次会话尾部 24h 完整保', () => {
    // 模拟用户上次会话在 6/19 14-15 段、之后 3 天没用、6/22 12:00 回来
    const lastSessionStart = new Date('2026-06-19T14:00:00Z').getTime();
    const lastSessionLatest = new Date('2026-06-19T15:00:00Z').getTime();
    const now = new Date('2026-06-22T12:00:00Z').getTime();

    const messages: Message[] = [
      makeTextMsg('session start', { addedAt: new Date(lastSessionStart).toISOString() }),
      makeTextMsg('session middle', { addedAt: new Date(lastSessionStart + 30 * 60_000).toISOString() }),
      makeTextMsg('session latest', { addedAt: new Date(lastSessionLatest).toISOString() }),
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 1_000_000, now }));
    // anchor = lastSessionLatest, threshold = lastSessionLatest - 24h = 6/18 15:00
    // 所有 3 条 > threshold → newerIdx 全保、不裁、无 summary
    expect(result.newMessages).toHaveLength(messages.length);
    expect(result.summaryMessageInjected).toBe(false);
    expect(result.droppedSystemMessages).toBe(0);
  });

  it('15. phase 757: 全无 addedAt → 全 olderIdx（不向后兼容、archive 兜底）', () => {
    // phase 757：无 addedAt 全归 olderIdx、命中 filterSubtypes 删验证分类
    const messages: Message[] = [
      { ...makeSystemMsg('[system message] msg 1 ' + '测'.repeat(200), 'claw_outbox_summary', NOW), addedAt: undefined },
      { ...makeSystemMsg('[system message] msg 2 ' + '测'.repeat(200), 'claw_outbox_summary', NOW), addedAt: undefined },
      { ...makeSystemMsg('[system message] msg 3 ' + '测'.repeat(200), 'claw_outbox_summary', NOW), addedAt: undefined },
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 300 }));
    expect(result.summaryMessageInjected).toBe(true);
    expect(result.droppedSystemMessages).toBe(3);
    // newMessages: [summary]（3 system msgs 全删）
    expect(result.newMessages).toHaveLength(1);
  });

  it('16. phase 757: 混合（部分有 addedAt + 部分无）→ anchor 自有 addedAt 算', () => {
    const messages: Message[] = [
      { ...makeSystemMsg('[system message] no addedat ' + '测'.repeat(200), 'claw_outbox_summary', NOW), addedAt: undefined }, // olderIdx
      makeTextMsg('latest ' + '测'.repeat(100), { addedAt: new Date(NOW).toISOString() }),                                     // newerIdx (anchor)
      { ...makeSystemMsg('[system message] no addedat 2 ' + '测'.repeat(200), 'claw_outbox_summary', NOW), addedAt: undefined },// olderIdx
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 500 }));
    // anchor = NOW、threshold = NOW - RW、addedAt = NOW 进 newerIdx、无 addedAt 进 olderIdx
    expect(result.summaryMessageInjected).toBe(true);
    expect(result.droppedSystemMessages).toBe(2);   // 2 无 addedAt system msgs 命中 filterSubtypes
    // newMessages: [summary, latest with addedat]
    expect(result.newMessages).toHaveLength(2);
  });

  it('17. phase 757: 单条最新 addedAt 决定 anchor、其他更老都被裁', () => {
    const old1 = new Date('2026-06-17T10:00:00Z').getTime();
    const old2 = new Date('2026-06-17T11:00:00Z').getTime();
    const latest = new Date('2026-06-19T15:00:00Z').getTime();   // anchor、threshold = 6/18 15:00
    const messages: Message[] = [
      makeSystemMsg('[system message] older 1 ' + '测'.repeat(200), 'claw_outbox_summary', old1),
      makeSystemMsg('[system message] older 2 ' + '测'.repeat(200), 'claw_outbox_summary', old2),
      makeTextMsg('latest ' + '测'.repeat(100), { addedAt: new Date(latest).toISOString() }),
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 500, now: latest }));
    // 2 老 (6/17) < threshold (6/18 15:00) → olderIdx、命中 filterSubtypes 删；latest > threshold → newerIdx
    expect(result.summaryMessageInjected).toBe(true);
    expect(result.droppedSystemMessages).toBe(2);
    // newMessages: [summary, latest]
    expect(result.newMessages).toHaveLength(2);
  });

  it('18. phase 757: 频繁用户 (latest = now) 行为同现行', () => {
    // latest_addedAt = opts.now → threshold = opts.now - RW、跟 phase 757 之前行为一致
    const old1 = NOW - RECENT_WINDOW_MS - 100;
    const messages: Message[] = [
      makeSystemMsg('[system message] old ' + '测'.repeat(200), 'claw_outbox_summary', old1),       // olderIdx
      makeTextMsg('latest ' + '测'.repeat(100), { addedAt: new Date(NOW).toISOString() }),          // newerIdx (anchor)
    ];
    const result = trimV2(messages, baseOpts({ targetMessagesTokens: 500 }));
    expect(result.droppedSystemMessages).toBe(1);   // claw_outbox_summary 命中 filterSubtypes → 删
    expect(result.summaryMessageInjected).toBe(true);
    // newMessages: [summary, latest]
    expect(result.newMessages).toHaveLength(2);
  });
});
