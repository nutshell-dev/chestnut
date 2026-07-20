/**
 * chat-viewport-claw-panel behavior tests
 *
 * Covers clawPanel display semantics without TUI assembly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClawPanel } from '../../src/cli/commands/chat-viewport-claw-panel.js';
import { makeClawTrack, type ClawTrack } from '../../src/cli/commands/chat-viewport-claw-line.js';

function makeAttachedClawBar() {
  const calls: string[] = [];
  return {
    setText: (text: string) => { calls.push(text); },
    calls,
  };
}

function makeRequestRender() {
  const calls: undefined[] = [];
  return {
    fn: () => { calls.push(undefined); },
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

async function drainNextTick() {
  await new Promise<void>(resolve => process.nextTick(resolve));
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
    it('startup 非空 map 同步 setText 且不 requestRender', () => {
      const bar = makeAttachedClawBar();
      const render = makeRequestRender();
      const panel = createClawPanel({ attachedClawBar: bar, requestRender: render.fn });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      track.isAlive = true;
      track.daemonStatus = 'running';
      map.set('search', track);

      panel.materializeNow(map);

      expect(bar.calls).toHaveLength(1);
      expect(bar.calls[0]).toContain('[search]');
      expect(render.calls).toHaveLength(0);
    });

    it('startup 空 map 同步写入空字符串', () => {
      const bar = makeAttachedClawBar();
      const render = makeRequestRender();
      const panel = createClawPanel({ attachedClawBar: bar, requestRender: render.fn });
      const map = new Map<string, ClawTrack>();

      panel.materializeNow(map);

      expect(bar.calls).toEqual(['']);
      expect(render.calls).toHaveLength(0);
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

  describe('updateClawPanel changed-only render', () => {
    it('runtime 首次不同文本产生 1 次 setText + 1 次 render', async () => {
      const bar = makeAttachedClawBar();
      const render = makeRequestRender();
      const panel = createClawPanel({ attachedClawBar: bar, requestRender: render.fn });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      map.set('x', track);

      panel.updateClawPanel(map);
      await drainNextTick();

      expect(bar.calls).toHaveLength(1);
      expect(render.calls).toHaveLength(1);
    });

    it('连续相同文本产生 0 新增 setText + 0 新增 render', async () => {
      const bar = makeAttachedClawBar();
      const render = makeRequestRender();
      const panel = createClawPanel({ attachedClawBar: bar, requestRender: render.fn });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      map.set('x', track);

      panel.materializeNow(map);
      panel.updateClawPanel(map);
      await drainNextTick();

      expect(bar.calls).toHaveLength(1);
      expect(render.calls).toHaveLength(0);
    });

    it('同 ID 状态改变产生恰 1 次 setText + 1 次 render', async () => {
      const bar = makeAttachedClawBar();
      const render = makeRequestRender();
      const panel = createClawPanel({ attachedClawBar: bar, requestRender: render.fn });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      map.set('x', track);

      panel.materializeNow(map);
      const firstText = bar.calls[0];

      track.isAlive = true;
      track.daemonStatus = 'running';
      panel.updateClawPanel(map);
      await drainNextTick();

      expect(bar.calls).toHaveLength(2);
      expect(bar.calls[1]).not.toBe(firstText);
      expect(render.calls).toHaveLength(1);
    });

    it('非空 -> 空写入 "" 并 render 一次', async () => {
      const bar = makeAttachedClawBar();
      const render = makeRequestRender();
      const panel = createClawPanel({ attachedClawBar: bar, requestRender: render.fn });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      map.set('x', track);

      panel.materializeNow(map);
      map.clear();
      panel.updateClawPanel(map);
      await drainNextTick();

      expect(bar.calls).toHaveLength(2);
      expect(bar.calls[1]).toBe('');
      expect(render.calls).toHaveLength(1);
    });

    it('columns 改变导致最终文本改变并 render', async () => {
      const bar = makeAttachedClawBar();
      const render = makeRequestRender();
      const panel = createClawPanel({ attachedClawBar: bar, requestRender: render.fn });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      track.isAlive = true;
      track.daemonStatus = 'running';
      track.lastOutput = 'a'.repeat(100);
      track.referenceMs = Date.now();
      map.set('x', track);

      setTerminalColumns(80);
      panel.materializeNow(map);
      const firstText = bar.calls[0];

      setTerminalColumns(40);
      panel.updateClawPanel(map);
      await drainNextTick();

      expect(bar.calls).toHaveLength(2);
      expect(bar.calls[1]).not.toBe(firstText);
      expect(render.calls).toHaveLength(1);
    });

    it('同 tick 多次 update 合并且保留最终文本', async () => {
      const bar = makeAttachedClawBar();
      const render = makeRequestRender();
      const panel = createClawPanel({ attachedClawBar: bar, requestRender: render.fn });
      const map = new Map<string, ClawTrack>();
      const track = makeClawTrack();
      track.hasContract = true;
      track.isAlive = true;
      track.daemonStatus = 'running';
      track.referenceMs = Date.now();
      map.set('x', track);

      panel.updateClawPanel(map);

      track.lastOutput = 'final snippet';
      panel.updateClawPanel(map);

      await drainNextTick();

      expect(bar.calls).toHaveLength(1);
      expect(bar.calls[0]).toContain('final snippet');
      expect(render.calls).toHaveLength(1);
    });
  });
});
