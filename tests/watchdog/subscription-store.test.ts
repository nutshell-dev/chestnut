/**
 * phase 5: subscription-store unit tests (file-based 一次性订阅).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  writeSubscription,
  listSubscriptions,
  consumeSubscription,
  MAX_THRESHOLD_MS,
  SUBSCRIPTION_DIR,
} from '../../src/watchdog/subscription-store.js';
import { WATCHDOG_AUDIT_EVENTS } from '../../src/watchdog/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

describe('phase 5: subscription-store', () => {
  let root: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `sub-store-${randomUUID()}`);
    await fsAsync.mkdir(root, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('empty dir → listSubscriptions returns []', () => {
    expect(listSubscriptions(fs)).toEqual([]);
  });

  it('writeSubscription creates file in subscription dir', async () => {
    writeSubscription(fs, 'clawA', { subscribed_at: 100, threshold_ms: 5 * 60_000 });
    const filePath = path.join(root, SUBSCRIPTION_DIR, 'clawA.json');
    const raw = await fsAsync.readFile(filePath, 'utf-8');
    expect(JSON.parse(raw)).toEqual({ subscribed_at: 100, threshold_ms: 5 * 60_000 });
  });

  it('listSubscriptions returns parsed', () => {
    writeSubscription(fs, 'clawA', { subscribed_at: 100, threshold_ms: 5_000 });
    writeSubscription(fs, 'clawB', { subscribed_at: 200, threshold_ms: 10_000 });
    const subs = listSubscriptions(fs).sort((a, b) => a.clawId.localeCompare(b.clawId));
    expect(subs).toEqual([
      { clawId: 'clawA', subscribed_at: 100, threshold_ms: 5_000 },
      { clawId: 'clawB', subscribed_at: 200, threshold_ms: 10_000 },
    ]);
  });

  it('consumeSubscription removes file', async () => {
    writeSubscription(fs, 'clawA', { subscribed_at: 100, threshold_ms: 5_000 });
    expect(listSubscriptions(fs).length).toBe(1);
    consumeSubscription(fs, 'clawA');
    expect(listSubscriptions(fs)).toEqual([]);
  });

  it('consumeSubscription on missing file is idempotent', () => {
    expect(() => consumeSubscription(fs, 'missingClaw')).not.toThrow();
  });

  it('writeSubscription overwrites previous (latest wins)', () => {
    writeSubscription(fs, 'clawA', { subscribed_at: 100, threshold_ms: 5_000 });
    writeSubscription(fs, 'clawA', { subscribed_at: 200, threshold_ms: 10_000 });
    const subs = listSubscriptions(fs);
    expect(subs).toEqual([{ clawId: 'clawA', subscribed_at: 200, threshold_ms: 10_000 }]);
  });

  it('writeSubscription rejects threshold > 24h', () => {
    expect(() =>
      writeSubscription(fs, 'clawA', { subscribed_at: 100, threshold_ms: MAX_THRESHOLD_MS + 1 }),
    ).toThrow();
  });

  it('listSubscriptions skips malformed JSON gracefully', async () => {
    writeSubscription(fs, 'clawA', { subscribed_at: 100, threshold_ms: 5_000 });
    // corrupt extra file
    await fsAsync.writeFile(path.join(root, SUBSCRIPTION_DIR, 'corrupt.json'), 'not json');
    const subs = listSubscriptions(fs);
    expect(subs.length).toBe(1);
    expect(subs[0].clawId).toBe('clawA');
  });

  it('corrupt JSON file → emits SUBSCRIPTION_CORRUPT audit + skip (phase 135)', async () => {
    writeSubscription(fs, 'clawA', { subscribed_at: 100, threshold_ms: 5_000 });
    await fsAsync.writeFile(path.join(root, SUBSCRIPTION_DIR, 'bad-claw.json'), '{invalid json');

    const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    const result = listSubscriptions(fs, mockAudit);

    // bad file → skip (return excludes it)
    expect(result.find(s => s.clawId === 'bad-claw')).toBeUndefined();

    // audit emitted
    expect(mockAudit.write).toHaveBeenCalledWith(
      WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_CORRUPT,
      'fname=bad-claw.json',
      expect.stringContaining('error='),
    );
  });

  it('corrupt JSON file → silent skip when audit not provided (backward compat)', async () => {
    writeSubscription(fs, 'clawA', { subscribed_at: 100, threshold_ms: 5_000 });
    await fsAsync.writeFile(path.join(root, SUBSCRIPTION_DIR, 'bad-claw.json'), '{invalid json');
    const result = listSubscriptions(fs); // no audit
    expect(result.find(s => s.clawId === 'bad-claw')).toBeUndefined();
    expect(result.length).toBe(1);
    expect(result[0].clawId).toBe('clawA');
    // 0 throw、行为完全等价 phase 135 前
  });
});
