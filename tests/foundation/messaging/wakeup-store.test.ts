/**
 * phase 1386: wakeup store 原语测试。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import {
  scheduleWakeup,
  cancelWakeup,
  listWakeups,
  consumeDueWakeups,
  removeWakeup,
  WAKEUP_SCHEMA_VERSION,
  WakeupNotFoundError,
  WakeupDecodeError,
  WAKEUPS_DIR,
} from '../../../src/foundation/messaging/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

function makeAudit(): { audit: AuditLog; calls: string[] } {
  const calls: string[] = [];
  return {
    audit: { write: (_e: string, ...cols: (string | number)[]) => void calls.push(`${_e}:${cols.join(',')}`) } as unknown as AuditLog,
    calls,
  };
}

describe('wakeup-store', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let clawDir: string;
  let audit: AuditLog;
  let auditCalls: string[];

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `wakeup-store-${randomUUID()}`);
    fs.mkdirSync(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    clawDir = 'claw1';
    nfs.ensureDirSync(clawDir);
    const a = makeAudit();
    audit = a.audit;
    auditCalls = a.calls;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('schedules a future wakeup as a persisted JSON file', () => {
    const deliverAt = new Date(Date.now() + 60_000).toISOString();
    const { record, immediate } = scheduleWakeup(nfs, clawDir, 'claw1', deliverAt, 'check site', audit);
    expect(immediate).toBe(false);
    expect(record.schema_version).toBe(WAKEUP_SCHEMA_VERSION);
    expect(record.message).toBe('check site');
    expect(record.deliverAt).toBe(deliverAt);
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/);

    const file = path.join(testDir, clawDir, WAKEUPS_DIR, `${record.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.id).toBe(record.id);
    expect(auditCalls.some(c => c.startsWith('wakeup_scheduled:'))).toBe(true);
  });

  it('marks a past deliverAt as immediate and does not persist', () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const { record, immediate } = scheduleWakeup(nfs, clawDir, 'claw1', past, 'late', audit);
    expect(immediate).toBe(true);
    const dir = path.join(testDir, clawDir, WAKEUPS_DIR);
    expect(fs.existsSync(dir)).toBe(false);
    expect(record.deliverAt).toBe(past);
  });

  it('lists wakeups sorted by deliverAt ascending', () => {
    const t1 = new Date(Date.now() + 120_000).toISOString();
    const t2 = new Date(Date.now() + 30_000).toISOString();
    const r1 = scheduleWakeup(nfs, clawDir, 'claw1', t1, 'later', audit).record;
    const r2 = scheduleWakeup(nfs, clawDir, 'claw1', t2, 'sooner', audit).record;
    const list = listWakeups(nfs, clawDir);
    expect(list.map(r => r.id)).toEqual([r2.id, r1.id]);
  });

  it('returns empty list when wakeups dir does not exist', () => {
    expect(listWakeups(nfs, clawDir)).toEqual([]);
  });

  it('consumeDueWakeups returns only records at or before now', () => {
    const future1 = new Date(Date.now() + 60_000).toISOString();
    const future2 = new Date(Date.now() + 120_000).toISOString();
    const r1 = scheduleWakeup(nfs, clawDir, 'claw1', future1, 'sooner', audit).record;
    const r2 = scheduleWakeup(nfs, clawDir, 'claw1', future2, 'later', audit).record;
    // advance "now" past r1 but before r2
    const now = new Date(Date.now() + 90_000);
    const result = consumeDueWakeups(nfs, clawDir, now);
    expect(result.map(r => r.id)).toEqual([r1.id]);
    expect(result.map(r => r.id)).not.toContain(r2.id);
  });

  it('consumeDueWakeups does not delete files', () => {
    const deliverAt = new Date(Date.now() + 60_000).toISOString();
    const r = scheduleWakeup(nfs, clawDir, 'claw1', deliverAt, 'due', audit).record;
    consumeDueWakeups(nfs, clawDir, new Date(Date.now() + 120_000));
    expect(fs.existsSync(path.join(testDir, clawDir, WAKEUPS_DIR, `${r.id}.json`))).toBe(true);
  });

  it('cancelWakeup deletes the file and audits cancelled', () => {
    const deliverAt = new Date(Date.now() + 60_000).toISOString();
    const { record } = scheduleWakeup(nfs, clawDir, 'claw1', deliverAt, 'x', audit);
    const returned = cancelWakeup(nfs, clawDir, 'claw1', record.id, audit);
    expect(returned.id).toBe(record.id);
    expect(fs.existsSync(path.join(testDir, clawDir, WAKEUPS_DIR, `${record.id}.json`))).toBe(false);
    expect(auditCalls.some(c => c.includes('status=cancelled'))).toBe(true);
    expect(listWakeups(nfs, clawDir)).toHaveLength(0);
  });

  it('cancelWakeup throws WakeupNotFoundError for unknown id', () => {
    expect(() => cancelWakeup(nfs, clawDir, 'claw1', 'does-not-exist', audit)).toThrow(WakeupNotFoundError);
    expect(auditCalls.some(c => c.includes('status=not_found'))).toBe(true);
  });

  it('removeWakeup is idempotent for missing file', () => {
    expect(() => removeWakeup(nfs, clawDir, 'missing')).not.toThrow();
  });

  it('removeWakeup deletes an existing file', () => {
    const r = scheduleWakeup(nfs, clawDir, 'claw1', new Date(Date.now() + 1000).toISOString(), 'x', audit).record;
    removeWakeup(nfs, clawDir, r.id);
    expect(listWakeups(nfs, clawDir)).toHaveLength(0);
  });

  it('throws on invalid deliverAt', () => {
    expect(() => scheduleWakeup(nfs, clawDir, 'claw1', 'not-a-date', 'x', audit)).toThrow(/invalid deliverAt/);
  });

  it('throws WakeupDecodeError on corrupt JSON file', () => {
    const dir = path.join(testDir, clawDir, WAKEUPS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    expect(() => listWakeups(nfs, clawDir)).toThrow(WakeupDecodeError);
  });

  it('persists across a fresh fs instance (restart recovery)', () => {
    const deliverAt = new Date(Date.now() + 60_000).toISOString();
    const { record } = scheduleWakeup(nfs, clawDir, 'claw1', deliverAt, 'persist me', audit);
    const reopened = new NodeFileSystem({ baseDir: testDir });
    const list = listWakeups(reopened, clawDir);
    expect(list.map(r => r.id)).toContain(record.id);
  });
});
