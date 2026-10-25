/**
 * chat-viewport-claw-panel behavior tests
 *
 * Covers clawPanel display semantics without TUI assembly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClawPanel, createRescanClawsDir } from '../../src/viewport/chat-viewport-claw-panel.js';
import { makeClawTrack, type ClawTrack } from '../../src/viewport/chat-viewport-claw-line.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createClawTopology, MOTION_CLAW_ID } from '../../src/core/claw-topology/index.js';
import type { ClawTopology } from '../../src/core/claw-topology/index.js';
import { STREAM_FILE } from '../../src/foundation/stream/index.js';

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

// ==========================================================================
// Phase 1997 Step C: rescanClawsDir 消费 ClawTopology（不再 raw listSync）
// Phase 1997 Step D: 扫描失败审计状态去重 + recovered
// ==========================================================================

interface RescanHarness {
  rescan: () => Promise<void>;
  clawTrackMap: Map<string, ClawTrack>;
  auditWrites: unknown[][];
  attachCalls: Array<[string, string]>;
  refreshCalls: string[];
  updatePanelCalls: number;
  fsFactoryCalls: string[];
}

function makeRescanDeps(clawTopology: ClawTopology): RescanHarness {
  const clawTrackMap = new Map<string, ClawTrack>();
  const auditWrites: unknown[][] = [];
  const attachCalls: Array<[string, string]> = [];
  const refreshCalls: string[] = [];
  const fsFactoryCalls: string[] = [];
  let updatePanelCalls = 0;
  const rescan = createRescanClawsDir({
    fsFactory: (baseDir: string) => {
      fsFactoryCalls.push(baseDir);
      return new NodeFileSystem({ baseDir });
    },
    clawTopology,
    clawTrackMap,
    clawManager: {
      attachClawWatcher: (clawId: string, streamPath: string) => { attachCalls.push([clawId, streamPath]); },
      refreshClawStatus: (clawId: string) => { refreshCalls.push(clawId); },
    } as any,
    audit: { write: (...args: unknown[]) => { auditWrites.push(args); } } as any,
    agentDir: '/unused',
    updateClawPanel: () => { updatePanelCalls += 1; },
    pm: {
      inspectSpawning: () => ({ status: 'absent' }),
      isAlive: () => false,
    },
  });
  return {
    rescan, clawTrackMap, auditWrites, attachCalls, refreshCalls, fsFactoryCalls,
    get updatePanelCalls() { return updatePanelCalls; },
  };
}

const SCAN_FAILED = 'viewport_clawsdir_scan_failed';

describe('rescanClawsDir: topology 消费（phase 1997 Step C）', () => {
  let tmpDir: string;
  let root: string;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpDir = mkdtempSync(join(tmpdir(), 'phase1997-claw-panel-'));
    root = join(tmpDir, '.chestnut');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRealTopology() {
    return createClawTopology({
      fs: new NodeFileSystem({ baseDir: root }),
      chestnutRoot: root,
      motionDir: MOTION_CLAW_ID,
      sink: { write: () => {} },
    });
  }

  function addClawWithContract(clawId: string) {
    mkdirSync(join(root, 'claws', clawId, 'contract', 'active', '1761300000000-abcd1234'), { recursive: true });
  }

  it('只把 topology valid 的普通 claw 加入 track；legacy claws/motion 不当系统 Motion、不写 scan failure', async () => {
    addClawWithContract('foo');
    // legacy 极端测试 fixture：claws/ 下同名 motion 目录（含 contract）
    addClawWithContract('motion');
    const h = makeRescanDeps(makeRealTopology());

    await h.rescan();

    expect([...h.clawTrackMap.keys()]).toEqual(['foo']);
    const track = h.clawTrackMap.get('foo')!;
    expect(track.hasContract).toBe(true);
    expect(track.referenceMs).toBe(1761300000000);
    expect(track.daemonStatus).toBe('stopped');
    // contract 读取走该 claw 自己的 FS（root = location.clawDir）
    expect(h.fsFactoryCalls).toEqual([join(root, 'claws', 'foo')]);
    expect(h.auditWrites.filter(w => w[0] === SCAN_FAILED)).toHaveLength(0);
    expect(h.updatePanelCalls).toBe(1);
  });

  it('daemon 不存活时走 refreshClawStatus，不 attach watcher', async () => {
    addClawWithContract('foo');
    const h = makeRescanDeps(makeRealTopology());

    await h.rescan();

    expect(h.refreshCalls).toEqual(['foo']);
    expect(h.attachCalls).toHaveLength(0);
  });

  it('daemon 存活时 attach watcher（路径 = clawDir/STREAM_FILE）', async () => {
    addClawWithContract('foo');
    const clawTrackMap = new Map<string, ClawTrack>();
    const attachCalls: Array<[string, string]> = [];
    const rescan = createRescanClawsDir({
      fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
      clawTopology: makeRealTopology(),
      clawTrackMap,
      clawManager: {
        attachClawWatcher: (clawId: string, streamPath: string) => { attachCalls.push([clawId, streamPath]); },
        refreshClawStatus: () => {},
      } as any,
      audit: { write: () => {} } as any,
      agentDir: '/unused',
      updateClawPanel: () => {},
      pm: { inspectSpawning: () => ({ status: 'absent' }), isAlive: () => true },
    });

    await rescan();

    expect(attachCalls).toEqual([['foo', join(root, 'claws', 'foo', STREAM_FILE)]]);
    expect(clawTrackMap.get('foo')!.daemonStatus).toBe('running');
  });

  it('新 claw 目录 → 下一次 rescan 发现；已 track 的 claw 不重复 attach', async () => {
    addClawWithContract('foo');
    const h = makeRescanDeps(makeRealTopology());
    await h.rescan();
    expect([...h.clawTrackMap.keys()]).toEqual(['foo']);
    expect(h.refreshCalls).toEqual(['foo']);

    addClawWithContract('bar');
    await h.rescan();

    expect([...h.clawTrackMap.keys()].sort()).toEqual(['bar', 'foo']);
    expect(h.refreshCalls).toEqual(['foo', 'bar']);
    // foo 已 track：没有第二次 contract FS / status 刷新之外的重复 attach
    expect(h.fsFactoryCalls.filter(p => p.endsWith(join('claws', 'foo')))).toHaveLength(1);
  });

  it('无 active contract 的 claw 不入 track', async () => {
    mkdirSync(join(root, 'claws', 'empty'), { recursive: true });
    const h = makeRescanDeps(makeRealTopology());

    await h.rescan();

    expect(h.clawTrackMap.size).toBe(0);
    expect(h.auditWrites.filter(w => w[0] === SCAN_FAILED)).toHaveLength(0);
  });
});
