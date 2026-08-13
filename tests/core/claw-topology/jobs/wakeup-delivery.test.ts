/**
 * phase 1386: wakeup-delivery cron job 测试（投递 + 删除 / 失败保留重试 / 重启恢复）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../../src/foundation/audit/index.js';
import type { ClawTopology } from '../../../../src/core/claw-topology/types.js';
import {
  runWakeupDeliveryTick,
  createWakeupDeliveryJob,
} from '../../../../src/core/claw-topology/jobs/wakeup-delivery/index.js';
import { scheduleWakeup, listWakeups, type WakeupRecord } from '../../../../src/foundation/messaging/index.js';
import { makeClawId } from '../../../../src/foundation/claw-identity/index.js';
import { parseSchedule } from '../../../../src/foundation/cron/index.js';

function makeAudit(): { audit: AuditLog; writes: string[] } {
  const writes: string[] = [];
  return {
    audit: { write: (e: string, ...cols: (string | number)[]) => void writes.push(`${e}:${cols.join(',')}`) } as unknown as AuditLog,
    writes,
  };
}

interface FakeClaw {
  id: string;
  dir: string;
}

function makeTopology(fs: FileSystem, claws: FakeClaw[]): ClawTopology {
  return {
    enumerate: () => claws.map(c => makeClawId(c.id)),
    resolve: (clawId) => {
      const found = claws.find(c => c.id === clawId);
      if (!found) throw new Error(`not found: ${clawId}`);
      return { kind: 'local' as const, clawDir: found.dir };
    },
    read: async () => { throw new Error('not used'); },
    readJSON: async () => { throw new Error('not used'); },
  };
}

describe('wakeup-delivery job', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let clawDir: string;
  let audit: AuditLog;
  let auditWrites: string[];
  let delivered: Array<{ target: string; body: string; type: string }>;
  let notifyImpl: (target: string, msg: { type: string; body: string }) => Promise<void>;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `wakeup-delivery-${randomUUID()}`);
    fs.mkdirSync(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    clawDir = 'clawA';
    nfs.ensureDirSync(clawDir);
    const a = makeAudit();
    audit = a.audit;
    auditWrites = a.writes;
    delivered = [];
    notifyImpl = async (target, msg) => {
      delivered.push({ target, body: msg.body, type: msg.type });
    };
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function schedule(deliverAt: Date, message: string): WakeupRecord {
    return scheduleWakeup(nfs, clawDir, 'clawA', deliverAt.toISOString(), message, audit).record;
  }

  // Schedule a wakeup in the future so it persists, then run the tick with a
  // mocked `now` after the delivery time. (scheduleWakeup treats past deliverAt
  // as immediate and does not persist — the store only holds future items.)
  function scheduleFutureAndTick(secondsFromNow: number, message: string, notify = notifyImpl) {
    const deliverAt = new Date(Date.now() + secondsFromNow * 1000);
    const record = schedule(deliverAt, message);
    const tickNow = new Date(deliverAt.getTime() + 1000);
    return tick(tickNow, notify).then(result => ({ result, record }));
  }

  function tick(now: Date, notify = notifyImpl) {
    const topology = makeTopology(nfs, [{ id: 'clawA', dir: clawDir }]);
    return runWakeupDeliveryTick(
      { clawTopology: topology, fs: nfs, audit, sourceClawId: 'motion', notifyClaw: notify },
      now,
    );
  }

  it('delivers due wakeups to target claw inbox and removes files', async () => {
    const { record } = await scheduleFutureAndTick(60, 'wake up');
    expect(delivered).toEqual([{ target: 'clawA', body: 'wake up', type: 'wakeup' }]);
    expect(listWakeups(nfs, clawDir)).toHaveLength(0);
    expect(auditWrites.some(w => w.startsWith('wakeup_delivered:'))).toBe(true);
    expect(record.id).toBeTruthy();
  });

  it('does not deliver future wakeups', async () => {
    schedule(new Date(Date.now() + 60_000), 'future');
    const result = await tick(new Date());
    expect(result.delivered).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(listWakeups(nfs, clawDir)).toHaveLength(1);
  });

  it('on notify failure keeps the file and audits failure (retried next tick)', async () => {
    const deliverAt = new Date(Date.now() + 60_000);
    const record = schedule(deliverAt, 'retry me');
    const failing = async () => { throw new Error('disk full'); };
    const result1 = await tick(new Date(deliverAt.getTime() + 1000), failing);
    expect(result1.failed).toBe(1);
    expect(result1.delivered).toBe(0);
    // file retained
    expect(listWakeups(nfs, clawDir).map(r => r.id)).toContain(record.id);
    expect(auditWrites.some(w => w.startsWith('wakeup_deliver_failed:'))).toBe(true);

    // next tick with working notify delivers + removes
    const result2 = await tick(new Date(deliverAt.getTime() + 2000));
    expect(result2.delivered).toBe(1);
    expect(listWakeups(nfs, clawDir)).toHaveLength(0);
  });

  it('delivers across multiple claws in one tick', async () => {
    const clawBDir = 'clawB';
    nfs.ensureDirSync(clawBDir);
    const at = new Date(Date.now() + 60_000);
    schedule(at, 'a');
    scheduleWakeup(nfs, clawBDir, 'clawB', at.toISOString(), 'b', audit);

    const topology = makeTopology(nfs, [
      { id: 'clawA', dir: clawDir },
      { id: 'clawB', dir: clawBDir },
    ]);
    const result = await runWakeupDeliveryTick(
      { clawTopology: topology, fs: nfs, audit, sourceClawId: "motion", notifyClaw: notifyImpl },
      new Date(at.getTime() + 1000),
    );
    expect(result.delivered).toBe(2);
    expect(delivered.map(d => d.target).sort()).toEqual(['clawA', 'clawB']);
  });

  it('isolates one claw failure from the rest', async () => {
    const clawBDir = 'clawB';
    nfs.ensureDirSync(clawBDir);
    const at = new Date(Date.now() + 60_000);
    schedule(at, 'a');
    scheduleWakeup(nfs, clawBDir, 'clawB', at.toISOString(), 'b', audit);

    const topology = makeTopology(nfs, [
      { id: 'clawA', dir: clawDir },
      { id: 'clawB', dir: clawBDir },
    ]);
    const notify = async (target: string) => {
      if (target === 'clawA') throw new Error('clawA down');
      delivered.push({ target, body: 'b', type: 'wakeup' });
    };
    const result = await runWakeupDeliveryTick(
      { clawTopology: topology, fs: nfs, audit, sourceClawId: "motion", notifyClaw: notify },
      new Date(at.getTime() + 1000),
    );
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(1);
    expect(delivered.map(d => d.target)).toEqual(['clawB']);
    // clawA file retained
    expect(listWakeups(nfs, clawDir)).toHaveLength(1);
    expect(listWakeups(nfs, clawBDir)).toHaveLength(0);
  });

  it('recovers scheduled wakeups after restart (persisted store)', async () => {
    const at = new Date(Date.now() + 60_000);
    const record = schedule(at, 'after restart');
    // simulate restart: fresh fs handle but same on-disk dir
    const reopened = new NodeFileSystem({ baseDir: testDir });
    const topology = makeTopology(reopened, [{ id: 'clawA', dir: clawDir }]);
    const result = await runWakeupDeliveryTick(
      { clawTopology: topology, fs: reopened, audit, sourceClawId: "motion", notifyClaw: notifyImpl },
      new Date(at.getTime() + 1000),
    );
    expect(result.delivered).toBe(1);
    expect(delivered[0].body).toBe('after restart');
    expect(listWakeups(reopened, clawDir).map(r => r.id)).not.toContain(record.id);
  });

  it('createWakeupDeliveryJob builds a CronJob descriptor', () => {
    const topology = makeTopology(nfs, [{ id: 'clawA', dir: clawDir }]);
    const job = createWakeupDeliveryJob(
      { clawTopology: topology, fs: nfs, audit, sourceClawId: "motion", notifyClaw: notifyImpl },
      { cron: { jobs: { wakeup_delivery: { enabled: true, schedule: 'interval:30s' } } } },
    );
    expect(job.name).toBe('wakeup-delivery');
    expect(job.enabled).toBe(true);
    expect(job.schedule).toEqual(parseSchedule('interval:30s'));
    expect(job.timeoutMs).toBeGreaterThan(0);
  });
});
