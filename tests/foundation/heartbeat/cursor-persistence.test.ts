/**
 * Phase 1791 Step B: Heartbeat 调度游标持久化（HEARTBEAT-SCHEDULE-CURSOR-NOT-DURABLE）。
 *
 * - 重启恢复：fire 成功原子写 cursor；新实例 initialize() → found 恢复 due 基线。
 * - 缺失 = 首次启动（audit 证据）；损坏/IO 故障 = typed degraded（不伪造恢复时间）。
 * - persist 失败不前移内存游标（保留旧值重试、dedup 防重复 notify）。
 * - wall-clock rollback 与持久 cursor 交互复用 observeNow（rollback audit 保留）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { Heartbeat, createHeartbeatCursorStore } from '../../../src/core/heartbeat/index.js';
import type { CursorRead, HeartbeatCursorStore } from '../../../src/core/heartbeat/index.js';
import { HEARTBEAT_AUDIT_EVENTS } from '../../../src/core/heartbeat/audit-events.js';
import { createInboxReader } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeChestnutRoot } from '../../../src/foundation/claw-identity/index.js';
import { makeClawNotifyTargetResolver } from '../../../src/core/claw-topology/index.js';
import { createClawNotifier } from '../../../src/foundation/messaging/index.js';
import { makeAudit } from '../../helpers/audit.js';

const CURSOR_PATH = 'motion/heartbeat-cursor.json';

describe('Heartbeat cursor persistence (phase 1791)', () => {
  let root: string;
  let nodeFs: NodeFileSystem;
  let auditEvents: Array<[string, ...(string | number)[]]>;
  let notified: number;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `hb-cursor-${randomUUID()}`);
    fs.mkdirSync(path.join(root, 'motion', 'inbox', 'pending'), { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: root });
    notified = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeHeartbeat(clock: { now: number }, intervalSec = 1, store?: HeartbeatCursorStore): Heartbeat {
    const { audit, events } = makeAudit();
    auditEvents = events;
    const inboxReader = createInboxReader(nodeFs, audit, path.join(root, 'motion', 'inbox'));
    const chestnutRoot = makeChestnutRoot(root);
    return new Heartbeat({
      interval: intervalSec,
      audit,
      inboxReader,
      notifyInbox: (msg) => {
        notified += 1;
        createClawNotifier({ fs: nodeFs, audit, resolveTarget: makeClawNotifyTargetResolver(chestnutRoot) }).notify('motion', msg);
      },
      now: () => clock.now,
      cursorStore: store ?? createHeartbeatCursorStore(nodeFs, CURSOR_PATH),
    });
  }

  it('重启恢复：fire 成功写 cursor；新实例 initialize → found，due 基线从 cursor 起算', async () => {
    const clock = { now: 1_000_000 };
    const hb1 = makeHeartbeat(clock);
    await hb1.initialize();  // 首次启动 absent
    clock.now += 1000;       // 等满 interval
    expect(hb1.isDue()).toBe(true);
    await hb1.fire();
    expect(notified).toBe(1);

    // cursor 文件已原子写入
    const cursorRaw = fs.readFileSync(path.join(root, CURSOR_PATH), 'utf-8');
    expect(JSON.parse(cursorRaw)).toEqual({ schema_version: 1, last_run_ms: 1_001_000 });

    // 模拟重启：新实例同时钟同 store
    const hb2 = makeHeartbeat(clock);
    const read = await hb2.initialize();
    expect(read).toEqual({ kind: 'found', value: { schema_version: 1, last_run_ms: 1_001_000 } } satisfies CursorRead);
    // 基线恢复：未到 interval 不 due
    expect(hb2.isDue()).toBe(false);
    clock.now += 999;
    expect(hb2.isDue()).toBe(false);
    clock.now += 1;
    expect(hb2.isDue()).toBe(true);
  });

  it('cursor 缺失 = 首次启动：absent + audit 证据，从 now 等满 interval', async () => {
    const clock = { now: 2_000_000 };
    const hb = makeHeartbeat(clock);
    const read = await hb.initialize();
    expect(read).toEqual({ kind: 'absent' } satisfies CursorRead);
    expect(auditEvents.filter(e => e[0] === HEARTBEAT_AUDIT_EVENTS.CURSOR_ABSENT)).toHaveLength(1);
    expect(hb.isDue()).toBe(false);
    clock.now += 1000;
    expect(hb.isDue()).toBe(true);
  });

  it('cursor 损坏 → malformed degraded（不伪造恢复时间、audit 保留 error）', async () => {
    fs.writeFileSync(path.join(root, CURSOR_PATH), 'NOT VALID JSON{{{');
    const clock = { now: 3_000_000 };
    const hb = makeHeartbeat(clock);
    const read = await hb.initialize();
    expect(read.kind).toBe('malformed');
    if (read.kind !== 'malformed') throw new Error('unreachable');
    expect(read.error).toBeTruthy();
    const degraded = auditEvents.filter(e => e[0] === HEARTBEAT_AUDIT_EVENTS.CURSOR_DEGRADED);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].join('\t')).toContain('stage=malformed');
    // 安全策略：从 now 重建等满 interval
    expect(hb.isDue()).toBe(false);
    clock.now += 1000;
    expect(hb.isDue()).toBe(true);
  });

  it('cursor schema 不符 → malformed（不当作 found）', async () => {
    fs.writeFileSync(path.join(root, CURSOR_PATH), JSON.stringify({ schema_version: 99, last_run_ms: 'NaN-ish' }));
    const clock = { now: 3_500_000 };
    const hb = makeHeartbeat(clock);
    const read = await hb.initialize();
    expect(read.kind).toBe('malformed');
  });

  it('cursor 读取 IO 故障（非 ENOENT）→ unavailable degraded（stage/error 保留）', async () => {
    const boom = Object.assign(new Error('EACCES read denied'), { code: 'EACCES' });
    const errFs = new Proxy(nodeFs, {
      get(target, prop) {
        if (prop === 'read') return async () => { throw boom; };
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    }) as unknown as NodeFileSystem;
    const clock = { now: 4_000_000 };
    const hb = makeHeartbeat(clock, 1, createHeartbeatCursorStore(errFs, CURSOR_PATH));
    const read = await hb.initialize();
    expect(read.kind).toBe('unavailable');
    if (read.kind !== 'unavailable') throw new Error('unreachable');
    expect(read.error).toContain('EACCES');
    const degraded = auditEvents.filter(e => e[0] === HEARTBEAT_AUDIT_EVENTS.CURSOR_DEGRADED);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].join('\t')).toContain('stage=unavailable');
  });

  it('persist 失败：lastRun 不前移（isDue 立即仍 true）+ cursor_persist_failed audit；恢复后 dedup 分支重试成功不重复 notify', async () => {
    const boom = new Error('ENOSPC cursor write');
    const base = createHeartbeatCursorStore(nodeFs, CURSOR_PATH);
    const writeSpy = vi.fn()
      .mockRejectedValueOnce(boom)
      .mockImplementation((c: Parameters<HeartbeatCursorStore['write']>[0]) => base.write(c));
    const store: HeartbeatCursorStore = { read: base.read, write: writeSpy };
    const clock = { now: 5_000_000 };
    const hb = makeHeartbeat(clock, 1, store);
    await hb.initialize();
    clock.now += 1000;
    expect(hb.isDue()).toBe(true);

    await hb.fire();  // notify 成功、persist 失败
    expect(notified).toBe(1);
    expect(hb.isDue()).toBe(true);  // 保留旧值 → 立即可重试
    const persistFailed = auditEvents.filter(e => e[0] === HEARTBEAT_AUDIT_EVENTS.CURSOR_PERSIST_FAILED);
    expect(persistFailed).toHaveLength(1);
    expect(persistFailed[0].join('\t')).toContain('ENOSPC');

    await hb.fire();  // dedup 分支（pending heartbeat 已存在）→ persist 重试成功
    expect(notified).toBe(1);  // 不重复 notify
    expect(hb.isDue()).toBe(false);  // persist 成功才前移
    expect(writeSpy).toHaveBeenCalledTimes(2);
    // cursor 已持久化
    expect(JSON.parse(fs.readFileSync(path.join(root, CURSOR_PATH), 'utf-8'))).toEqual({ schema_version: 1, last_run_ms: 5_001_000 });
  });

  it('rollback × 持久 cursor：恢复基线晚于当前时钟 → observeNow 重锚定 + rollback audit（不重复 heartbeat）', async () => {
    const clock = { now: 6_000_000 };
    const hb1 = makeHeartbeat(clock);
    await hb1.initialize();
    clock.now += 1000;
    await hb1.fire();
    expect(notified).toBe(1);

    // 重启 + 时钟回拨到 cursor 之前
    clock.now = 5_500_000;
    const hb2 = makeHeartbeat(clock);
    const read = await hb2.initialize();
    expect(read.kind).toBe('found');
    // isDue 观测触发 rollback：重锚定到 5_500_000，不 due、audit 保留
    expect(hb2.isDue()).toBe(false);
    const rollback = auditEvents.filter(e => e[0] === HEARTBEAT_AUDIT_EVENTS.CLOCK_ROLLBACK);
    expect(rollback).toHaveLength(1);
    expect(rollback[0].join('\t')).toContain('last_run=6001000');
    expect(rollback[0].join('\t')).toContain('now=5500000');
    // 重锚定后等满 interval 才 due
    clock.now += 999;
    expect(hb2.isDue()).toBe(false);
    clock.now += 1;
    expect(hb2.isDue()).toBe(true);
  });
});
