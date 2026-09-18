import { describe, it, expect } from 'vitest';

import {
  buildContextTrimSummaryMessage,
  type ContextTrimSummaryStats,
} from '../../../src/foundation/dialog-store/index.js';

const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

function makeStats(overrides?: Partial<ContextTrimSummaryStats>): ContextTrimSummaryStats {
  return {
    processedCount: 3,
    subtypeStat: { preserved: { heartbeat: 2, task_result: 1 } },
    toolStat: { total: 5, byTool: { send: 3, read: 2 } },
    nowMs: NOW_MS,
    ...overrides,
  };
}

describe('buildContextTrimSummaryMessage (phase 1861, CM-D5)', () => {
  it('message shape is owner-owned (systemSubtype literal lives in DialogStore)', () => {
    const msg = buildContextTrimSummaryMessage(makeStats());
    expect(msg.role).toBe('user');
    expect(msg.origin).toBe('system');
    expect(msg.systemSubtype).toBe('context_trim_summary');
    expect(msg.addedAt).toBe(new Date(NOW_MS).toISOString());
  });

  it('summary text format is byte-identical to the pre-migration shape', () => {
    const msg = buildContextTrimSummaryMessage(makeStats());
    expect(msg.content).toBe(
      `[context-trim summary] 以下为裁剪边界（裁剪时间：2023-11-14T22:13:20.000Z）。前 3 条消息已处理：系统通知（保留预览）：heartbeat × 2、task_result × 1；工具调用：5 次（send 3、read 2）。查回原文：dialog 归档 archive/<ts>_<uuid>.json`,
    );
  });

  it('empty stats render 无 fallbacks', () => {
    const msg = buildContextTrimSummaryMessage(
      makeStats({ subtypeStat: { preserved: {} }, toolStat: { total: 0, byTool: {} } }),
    );
    expect(msg.content).toContain('系统通知（保留预览）：无；工具调用：0 次（无）');
  });
});
