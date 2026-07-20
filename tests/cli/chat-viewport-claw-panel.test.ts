/**
 * chat-viewport-claw-panel behavior tests
 *
 * Covers clawPanel display semantics without TUI assembly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClawPanel } from '../../src/cli/commands/chat-viewport-claw-panel.js';
import { makeClawTrack, type ClawTrack } from '../../src/cli/commands/chat-viewport-claw-line.js';

function makeAttachedClawBar() {
  const calls: string[] = [];
  return {
    setText: (text: string) => { calls.push(text); },
    calls,
  };
}

function setTerminalColumns(cols: number) {
  Object.defineProperty(process.stdout, 'columns', {
    value: cols,
    configurable: true,
    writable: true,
  });
}

describe('chat-viewport-claw-panel', () => {
  let originalColumns: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    setTerminalColumns(80);
  });

  afterEach(() => {
    if (originalColumns) {
      Object.defineProperty(process.stdout, 'columns', originalColumns);
    } else {
      delete (process.stdout as any).columns;
    }
  });

  describe('materializeNow', () => {
    it('非空 map 同步写入一行 setText', () => {
      const bar = makeAttachedClawBar();
      const panel = createClawPanel({ attachedClawBar: bar });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      track.isAlive = true;
      track.daemonStatus = 'running';
      map.set('search', track);

      panel.materializeNow(map);

      expect(bar.calls).toHaveLength(1);
      expect(bar.calls[0]).toContain('[search]');
    });

    it('空 map 同步写入空字符串', () => {
      const bar = makeAttachedClawBar();
      const panel = createClawPanel({ attachedClawBar: bar });
      const map = new Map<string, ClawTrack>();

      panel.materializeNow(map);

      expect(bar.calls).toEqual(['']);
    });

    it('使用当前终端宽度渲染', () => {
      const bar = makeAttachedClawBar();
      const panel = createClawPanel({ attachedClawBar: bar });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      track.lastOutput = 'a'.repeat(200);
      track.referenceMs = Date.now();
      map.set('wide', track);

      setTerminalColumns(40);
      panel.materializeNow(map);

      const rendered = bar.calls[0];
      // Each physical line in the joined text should not exceed 40 visible cols.
      // BuildClawLine prefixes "[wide] ○ inactive ... · \"" so snippet is shorter than 200.
      expect(rendered.length).toBeLessThan(200);
      expect(rendered).toContain('[wide]');
    });

    it('多 entry 按 map 顺序换行连接', () => {
      const bar = makeAttachedClawBar();
      const panel = createClawPanel({ attachedClawBar: bar });
      const map = new Map<string, ClawTrack>();
      const t1 = makeClawTrack();
      t1.hasContract = true;
      map.set('a', t1);
      const t2 = makeClawTrack();
      t2.hasContract = true;
      map.set('b', t2);

      panel.materializeNow(map);

      expect(bar.calls[0]).toContain('\n');
      expect(bar.calls[0]).toMatch(/\[a\][\s\S]*\n[\s\S]*\[b\]/);
    });
  });

  describe('updateClawPanel', () => {
    it('首次非空 map 在 nextTick 写入 setText', async () => {
      const bar = makeAttachedClawBar();
      const panel = createClawPanel({ attachedClawBar: bar });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      map.set('x', track);

      panel.updateClawPanel(map);
      expect(bar.calls).toHaveLength(0);

      await vi.dynamicImportSettled?.().catch(() => {});
      await new Promise<void>(resolve => process.nextTick(resolve));

      expect(bar.calls).toHaveLength(1);
      expect(bar.calls[0]).toContain('[x]');
    });

    it('连续调用在同一 tick 内合并为一次 setText', async () => {
      const bar = makeAttachedClawBar();
      const panel = createClawPanel({ attachedClawBar: bar });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      map.set('x', track);

      panel.updateClawPanel(map);
      panel.updateClawPanel(map);
      panel.updateClawPanel(map);

      await new Promise<void>(resolve => process.nextTick(resolve));

      expect(bar.calls).toHaveLength(1);
    });
  });
});
