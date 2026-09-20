/**
 * Phase 1873 Step I: EventLoop fatal 的进程级恢复有界（计数 + 退避 + 升级）。
 *
 * 契约：
 * - 每次 fatal → audit（reason=eventloop_crash, consecutive, backoff_ms）+ 指数退避
 *   （1s 起翻倍封顶 30s；本文件 mock 常量为小值）；
 * - 一次正常 run 返回 → 连续计数归零（单次 fatal 的既有恢复语义不变）；
 * - 达上限 → audit restart_budget_exhausted + onFatalExhausted 收束回调（缺省 exit(1)）；
 * - stop() 可中断退避等待、不拖延退出。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as fs from 'fs';

vi.mock('../../src/daemon/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/constants.js')>();
  return {
    ...actual,
    // 小值锁状态机（真 timer、秒级内完成）
    MAX_LOOP_FATAL_RESTARTS: 3,
    LOOP_FATAL_BACKOFF_INITIAL_MS: 10,
    LOOP_FATAL_BACKOFF_MAX_MS: 20,
  };
});

import { startDaemonLoop } from '../../src/daemon/daemon-loop.js';
import { DAEMON_AUDIT_EVENTS } from '../../src/daemon/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { EventLoop } from '../../src/core/event-loop/index.js';
import type { Watcher, WatchEvent, WatcherFactory } from '../../src/foundation/file-watcher/index.js';

function createMockAudit() {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

function createFakeWatcher(): Watcher {
  return {
    close: vi.fn(() => Promise.resolve()),
    isActive: vi.fn(() => true),
    getPath: vi.fn((p: string) => p),
  } as unknown as Watcher;
}

describe('phase 1873 Step I: daemon-loop fatal 有界恢复', () => {
  let agentDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `daemon-fatal-budget-${randomUUID()}`);
    fs.mkdirSync(path.join(agentDir, 'inbox', 'pending'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function fatalEntries(audit: ReturnType<typeof createMockAudit>) {
    return audit.entries.filter(e =>
      e[0] === DAEMON_AUDIT_EVENTS.LOOP_FATAL &&
      e.some(c => String(c) === 'reason=eventloop_crash'));
  }

  function startWith(run: ReturnType<typeof vi.fn>, audit: ReturnType<typeof createMockAudit>, onFatalExhausted?: (info: { consecutive: number }) => Promise<void>) {
    const eventLoop = { run, abort: vi.fn() } as unknown as EventLoop;
    return startDaemonLoop({
      fsFactory,
      eventLoop,
      agentDir,
      clawId: 'test-claw',
      label: '[test daemon]',
      audit: audit as never,
      createWatcher: (() => createFakeWatcher()) as WatcherFactory,
      ...(onFatalExhausted ? { onFatalExhausted } : {}),
    });
  }

  it('连续 fatal：退避序列（10→20→20）+ 达上限 audit + onFatalExhausted 收束', async () => {
    const audit = createMockAudit();
    const run = vi.fn().mockRejectedValue(new Error('loop crash'));
    const onFatalExhausted = vi.fn().mockResolvedValue(undefined);

    const { promise, stop } = startWith(run, audit, onFatalExhausted);
    await promise;
    stop();

    const fatals = fatalEntries(audit);
    expect(fatals).toHaveLength(3);
    expect(fatals.map(e => e.find(c => String(c).startsWith('consecutive=')))).toEqual([
      'consecutive=1', 'consecutive=2', 'consecutive=3',
    ]);
    expect(fatals.map(e => e.find(c => String(c).startsWith('backoff_ms=')))).toEqual([
      'backoff_ms=10', 'backoff_ms=20', 'backoff_ms=20',
    ]);
    expect(audit.entries.some(e =>
      e[0] === DAEMON_AUDIT_EVENTS.LOOP_FATAL &&
      e.some(c => String(c) === 'reason=restart_budget_exhausted') &&
      e.some(c => String(c) === 'consecutive=3'))).toBe(true);
    expect(onFatalExhausted).toHaveBeenCalledWith({ consecutive: 3 });
  });

  it('正常 tick 后计数归零：reject→resolve→reject 的 consecutive 回到 1', async () => {
    const audit = createMockAudit();
    // 每次 tick 带真实耗时（防成功路径自旋；同既有 harness 的 EVENTLOOP_TICK_MS 模式）
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const run = vi.fn()
      .mockImplementationOnce(async () => { await sleep(20); throw new Error('crash-1'); })
      .mockImplementationOnce(async () => { await sleep(20); })                 // 正常返回 → 归零
      .mockImplementationOnce(async () => { await sleep(20); throw new Error('crash-2'); })
      .mockImplementation(async () => { await sleep(500); });
    const onFatalExhausted = vi.fn().mockResolvedValue(undefined);

    const { promise, stop } = startWith(run, audit, onFatalExhausted);
    // 等第 3 次 run（第 2 次 fatal）落地（20ms+10ms 退避+20ms+20ms tick 预算）
    await new Promise(r => setTimeout(r, 150));
    stop();
    await promise.catch(() => { /* silent: teardown */ });

    const fatals = fatalEntries(audit);
    expect(fatals.length).toBeGreaterThanOrEqual(2);
    expect(fatals[0].some(c => String(c) === 'consecutive=1')).toBe(true);
    // 中间一次正常返回已归零 → 第二次 fatal 的 consecutive 仍为 1（而非 2）
    expect(fatals[1].some(c => String(c) === 'consecutive=1')).toBe(true);
    expect(onFatalExhausted).not.toHaveBeenCalled();
  });

  it('stop() 可中断退避等待（不拖延退出）', async () => {
    const audit = createMockAudit();
    const run = vi.fn().mockRejectedValue(new Error('loop crash'));

    const { promise, stop } = startWith(run, audit);
    // 等首个 fatal 进入退避
    await new Promise(r => setTimeout(r, 15));
    const before = fatalEntries(audit).length;
    expect(before).toBeGreaterThanOrEqual(1);

    stop();
    await promise;   // 退避被中断 → 立即 resolve（无 hang）
    // 停止后不再有新 fatal
    expect(fatalEntries(audit).length).toBe(before);
  });
});
