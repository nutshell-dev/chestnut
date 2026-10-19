/**
 * Phase 1952 Step B：interrupt watcher close 次失败不静默丢弃。
 *
 * 契约：三处 close 调用点（disable / finally cleanup / error dispatch）失败时
 * 不阻塞主流程（既有语义），但必须写 LOOP_INTERRUPT_WATCHER_CLOSE_FAILED audit
 * （context 区分调用点），次失败可与主失败一起重建。
 *
 * 风格：不用 vi.mock——经 DaemonLoopOptions.createWatcher DI 缝注入 close 失败的
 * fake watcher（mirror daemon-loop-fatal-budget.test.ts），真 timer、真常量。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { startDaemonLoop } from '../../src/daemon/daemon-loop.js';
import { DAEMON_AUDIT_EVENTS } from '../../src/daemon/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { EventLoop } from '../../src/core/event-loop/index.js';
import type { Watcher, WatchEvent, WatcherFactory } from '../../src/foundation/file-watcher/index.js';
import { INTERRUPT_POLL_MAX_ERRORS } from '../../src/daemon/constants.js';

function createMockAudit() {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => { entries.push([type, ...cols]); },
  };
}

interface CapturedWatcher {
  onEvent: (event: WatchEvent) => void;
  onError?: (err: Error) => void;
}

let lastCaptured: CapturedWatcher | undefined;
const closeImpl = vi.fn(() => Promise.reject(new Error('close boom')));

/** close 恒失败的 fake watcher 工厂（经 DI 缝，真实 createInterruptWatcher 包装）。 */
const failingCloseWatcherFactory: WatcherFactory = ((
  _path: string,
  onEvent: (event: WatchEvent) => void,
  options?: { onError?: (err: Error) => void },
) => {
  lastCaptured = { onEvent, onError: options?.onError };
  return {
    close: closeImpl,
    isActive: vi.fn(() => true),
    getPath: vi.fn((p: string) => p),
  } as unknown as Watcher;
}) as WatcherFactory;

function closeFailedEntries(audit: ReturnType<typeof createMockAudit>, context?: string) {
  return audit.entries.filter(e =>
    e[0] === DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_WATCHER_CLOSE_FAILED &&
    (context === undefined || e.some(c => String(c) === `context=${context}`)));
}

describe('phase 1952 Step B: interrupt watcher close 次失败留证', () => {
  let agentDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `daemon-close-fail-${randomUUID()}`);
    fs.mkdirSync(path.join(agentDir, 'inbox', 'pending'), { recursive: true });
    lastCaptured = undefined;
    closeImpl.mockClear();
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function startWith(run: ReturnType<typeof vi.fn>, audit: ReturnType<typeof createMockAudit>) {
    const eventLoop = { run, abort: vi.fn() } as unknown as EventLoop;
    return startDaemonLoop({
      fsFactory,
      eventLoop,
      agentDir,
      clawId: 'test-claw',
      label: '[test daemon]',
      audit: audit as never,
      createWatcher: failingCloseWatcherFactory,
    });
  }

  it('error path：run reject → finally close 失败仍留证，主失败 audit 不受影响', async () => {
    const audit = createMockAudit();
    let calls = 0;
    let handle: { promise: Promise<void>; stop: () => void };
    const run = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('loop crash'));
      handle.stop();
      return Promise.resolve();
    });
    handle = startWith(run, audit);
    await handle.promise;

    // run reject 先经内层 finally close（context=cleanup）；catch 侧的 error close
    // 是 watcher 未被 finally 清空时的兜底备份。主失败与次失败分别保留。
    const closeFailures = closeFailedEntries(audit);
    expect(closeFailures.length).toBeGreaterThanOrEqual(1);
    expect(closeFailures[0].some(c => String(c).startsWith('reason=') && String(c).includes('close boom'))).toBe(true);
    expect(audit.entries.some(e =>
      e[0] === DAEMON_AUDIT_EVENTS.LOOP_FATAL &&
      e.some(c => String(c) === 'reason=eventloop_crash'))).toBe(true);
  });

  it('finally cleanup path：正常 tick 后 close 失败 → CLOSE_FAILED(context=cleanup)', async () => {
    const audit = createMockAudit();
    let handle: { promise: Promise<void>; stop: () => void };
    const run = vi.fn().mockImplementation(() => {
      handle.stop();
      return Promise.resolve();
    });
    handle = startWith(run, audit);
    await handle.promise;

    const closeFailures = closeFailedEntries(audit, 'cleanup');
    expect(closeFailures).toHaveLength(1);
    expect(closeFailures[0].some(c => String(c).includes('close boom'))).toBe(true);
  });

  it('disable path：poller 错误达上限后 close 失败 → CLOSE_FAILED(context=disable)，disable 主事实保留', async () => {
    const audit = createMockAudit();
    // run 永不自行 resolve（由测试手动了结），让 watcher onError 驱动 disable 分支
    let releaseRun: (() => void) | undefined;
    const run = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { releaseRun = resolve; }));
    const handle = startWith(run, audit);

    // 等 watcher 创建（首个 tick 启动）
    await vi.waitFor(() => { expect(lastCaptured?.onError).toBeDefined(); });
    for (let i = 0; i < INTERRUPT_POLL_MAX_ERRORS; i++) {
      lastCaptured!.onError!(new Error(`poll err ${i}`));
    }

    await vi.waitFor(() => {
      expect(closeFailedEntries(audit, 'disable').length).toBe(1);
    });
    expect(closeFailedEntries(audit, 'disable')[0].some(c => String(c).includes('close boom'))).toBe(true);
    // disable 主事实仍保留，close 次失败独立留证
    expect(audit.entries.some(e => e[0] === DAEMON_AUDIT_EVENTS.LOOP_INTERRUPT_POLLER_DISABLED)).toBe(true);

    handle.stop();  // 同时清掉 30s recovery timer
    releaseRun?.();
    await handle.promise;
  });
});
