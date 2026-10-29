/**
 * Phase 2022 Step C：launcher activity 与 viewport claw bar 的摘要方向契约。
 * 只比较语义摘要，不比较 ANSI、角色前缀、颜色或终端布局。
 */

import { describe, expect, it } from 'vitest';
import { LauncherActivityMapper } from '../../src/cli/launcher-envelope-producer.js';
import { buildClawLine, makeClawTrack } from '../../src/viewport/chat-viewport-claw-line.js';

function viewportSummary(text: string, bufferType: 'thinking' | 'text' = 'thinking'): string {
  const track = makeClawTrack();
  track.active = true;
  track.isAlive = true;
  track.daemonStatus = 'running';
  track.textBuffer = text;
  track.bufferType = bufferType;
  const line = buildClawLine('m', track, 1000).replace(/\x1b\[[0-9;]*m/g, '');
  const match = line.match(/⊙ \((.*)\)/);
  expect(match).not.toBeNull();
  return match![1];
}

describe('launcher / viewport activity prefix parity', () => {
  it('短 thinking 与裸 text 使用相同的开头摘要和换行净化', () => {
    for (const [type, bufferType] of [['thinking_delta', 'thinking'], ['text_delta', 'text']] as const) {
      const mapper = new LauncherActivityMapper('m');
      const first = mapper.map({ ts: 1, type, delta: '  先想\n第一步', trace_id: 't1' } as never);
      const second = mapper.map({ ts: 2, type, delta: '，再验证', trace_id: 't1' } as never);
      const buffered = '  先想\n第一步，再验证';
      expect(first?.detail).toBe('先想 第一步');
      expect(second?.detail).toBe('先想 第一步，再验证');
      expect(viewportSummary(buffered, bufferType)).toBe(second?.detail);
    }
  });

  it('长流式输入共享固定开头窗口，后续 delta 不把 launcher 摘要滚到尾部', () => {
    const mapper = new LauncherActivityMapper('m');
    const first = mapper.map({ ts: 1, type: 'thinking_delta', delta: 'A'.repeat(250), trace_id: 't1' } as never);
    const second = mapper.map({ ts: 2, type: 'thinking_delta', delta: 'LATEST-TAIL', trace_id: 't1' } as never);

    expect(first?.detail).toBe('A'.repeat(240));
    expect(second?.detail).toBe(first?.detail);
    // viewport 的最终列宽由 fitLine 决定；这里只证明其语义摘要保留同一开头。
    expect(viewportSummary(`${'A'.repeat(250)}LATEST-TAIL`).startsWith(second?.detail ?? '')).toBe(true);
  });
});
