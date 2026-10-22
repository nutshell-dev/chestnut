/**
 * Phase 1970 Step E: trim 输出 tool pair 邻接回归矩阵。
 *
 * 覆盖：
 * - 事故形态（mid-array recent summary + 大段丢弃）不产生 pair 内摘要；
 * - 跨 24h 边界的 tool pair 注入点钳制；
 * - reactive 尾部未配对 tool_use 不被摘要追加成伪响应；
 * - trim 输出通过 dialog invariant 的邻接检查。
 */
import { describe, expect, it, vi } from 'vitest';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/index.js';
import { assertDialogShapeInvariants } from '../../../src/foundation/dialog-store/invariants.js';
import {
  buildProactiveTrimPolicy,
  buildReactiveTrimPolicy,
  trimV2,
  type TrimPolicy,
} from '../../../src/core/context_manager/trim-v2.js';
import { makeAudit } from '../../helpers/audit.js';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const PREVIEW_BYTES = 100;

function trimOpts(policy: TrimPolicy) {
  return {
    recentWindowMs: RECENT_WINDOW_MS,
    previewBytes: PREVIEW_BYTES,
    fixedTokens: 0,
    policy,
    now: NOW,
    audit: { write: vi.fn() },
  };
}

function textMsg(text: string, ts: number): Message {
  return { role: 'user', content: text, origin: 'user', addedAt: new Date(ts).toISOString() };
}

function assistantMsg(content: Message['content'], ts: number): Message {
  return { role: 'assistant', content, addedAt: new Date(ts).toISOString() };
}

function toolResultMsg(id: string, ts: number, content = 'ok'): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
    addedAt: new Date(ts).toISOString(),
  };
}

function summaryMsg(text: string, ts: number): Message {
  return {
    role: 'user',
    content: text,
    origin: 'system',
    systemSubtype: 'context_trim_summary',
    addedAt: new Date(ts).toISOString(),
  };
}

function oldSystemMessages(count: number, baseTs: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `[system message] old ${i} ` + '测'.repeat(400),
    origin: 'system' as const,
    systemSubtype: 'task_result',
    addedAt: new Date(baseTs - i * 1000).toISOString(),
  }));
}

function hasToolUse(id: string) {
  return (m: Message): boolean => Array.isArray(m.content)
    && m.content.some(b => b.type === 'tool_use' && b.id === id);
}

function hasToolResult(id: string) {
  return (m: Message): boolean => Array.isArray(m.content)
    && m.content.some(b => b.type === 'tool_result' && b.tool_use_id === id);
}

function isContextTrimSummary(m: Message): boolean {
  return m.systemSubtype === 'context_trim_summary';
}

function assertToolPairsAdjacent(messages: readonly Message[]): void {
  const { audit, events } = makeAudit();
  assertDialogShapeInvariants(messages, audit);
  const bad = events.filter(e =>
    e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED &&
    (e.some(c => String(c).includes('kind=tool_use_result_not_adjacent')) ||
     e.some(c => String(c).includes('kind=orphan_tool_use')))
  );
  expect(bad).toEqual([]);
}

describe('Phase 1970 trim tool pair adjacency', () => {
  it('事故形态：mid-array recent summary + 大段丢弃不把摘要放进 pair', () => {
    const messages: Message[] = [
      textMsg('incident turn', NOW - RECENT_WINDOW_MS - 200),
      assistantMsg(
        [{ type: 'tool_use', id: 'incident_send', name: 'send', input: { content: 'x' } }],
        NOW - RECENT_WINDOW_MS - 199,
      ),
      toolResultMsg('incident_send', NOW - RECENT_WINDOW_MS - 198),
      // 旧 trim 注入的 mid-array recent summary：旧实现会把它当新窗口起点。
      summaryMsg('[context-trim summary] previous boundary', NOW - 100),
      ...oldSystemMessages(16, NOW - RECENT_WINDOW_MS - 197),
      textMsg('anchor', NOW),
    ];

    const result = trimV2(messages, trimOpts(buildProactiveTrimPolicy(500)));
    const out = result.outcome.newMessages;

    expect(result.metrics.summaryMessageInjected).toBe(true);
    assertToolPairsAdjacent(out);

    const useIdx = out.findIndex(hasToolUse('incident_send'));
    const resultIdx = out.findIndex(hasToolResult('incident_send'));
    const summaryIdx = out.findIndex(isContextTrimSummary);
    expect(useIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBe(useIdx + 1);
    if (summaryIdx >= 0) {
      expect(summaryIdx < useIdx || summaryIdx > resultIdx).toBe(true);
    }
  });

  it('跨 24h 边界的 tool pair：摘要钳制到 pair 外', () => {
    const messages: Message[] = [
      assistantMsg([
        { type: 'thinking', thinking: '测'.repeat(200) },
        { type: 'text', text: '测'.repeat(200) },
        { type: 'tool_use', id: 'boundary_pair', name: 'read', input: { path: '/x' } },
      ], NOW - RECENT_WINDOW_MS - 1),
      toolResultMsg('boundary_pair', NOW - 10),
      textMsg('anchor', NOW),
    ];

    const result = trimV2(messages, trimOpts(buildProactiveTrimPolicy(500)));
    const out = result.outcome.newMessages;

    expect(result.metrics.summaryMessageInjected).toBe(true);
    assertToolPairsAdjacent(out);

    const useIdx = out.findIndex(hasToolUse('boundary_pair'));
    const resultIdx = out.findIndex(hasToolResult('boundary_pair'));
    const summaryIdx = out.findIndex(isContextTrimSummary);
    expect(resultIdx).toBe(useIdx + 1);
    expect(summaryIdx < useIdx || summaryIdx > resultIdx).toBe(true);
  });

  it('reactive 尾部未配对 tool_use：摘要不追加成伪响应', () => {
    const messages: Message[] = [
      assistantMsg([
        { type: 'thinking', thinking: '测'.repeat(200) },
        { type: 'text', text: '测'.repeat(200) },
        { type: 'tool_use', id: 'tail_open', name: 'exec', input: { command: 'true' } },
      ], NOW - RECENT_WINDOW_MS - 1),
    ];
    // 窗口足够大，确保走「压缩够用 → injectSummaryAtEnd」而不是整 turn 丢弃。
    const policy = buildReactiveTrimPolicy({ contextWindow: 400, explicitMaxTokens: 10 });

    const result = trimV2(messages, trimOpts(policy));
    const out = result.outcome.newMessages;
    const summaryIdx = out.findIndex(isContextTrimSummary);
    const useIdx = out.findIndex(hasToolUse('tail_open'));

    expect(result.metrics.summaryMessageInjected).toBe(true);
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(summaryIdx < useIdx).toBe(true);
  });
});
