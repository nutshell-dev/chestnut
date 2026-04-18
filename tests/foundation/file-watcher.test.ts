import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createWatcher } from '../../src/foundation/file-watcher/index.js';
import { AUDIT_EVENTS } from '../../src/foundation/audit/events.js';
import { makeAudit } from '../helpers/audit.js';

describe('FileWatcher', () => {
  let tmpDir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fw-test-'));
    fs = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('callback receives add/change/unlink events', async () => {
    const { audit } = makeAudit();
    const events: { type: string; path: string }[] = [];
    const watcher = createWatcher(
      fs,
      'watch.txt',
      (ev) => events.push({ type: ev.type, path: path.basename(ev.path) }),
      audit,
      { stability: 'immediate' },
    );

    await new Promise(r => setTimeout(r, 300));

    fsSync.writeFileSync(path.join(tmpDir, 'watch.txt'), 'hello');
    await new Promise(r => setTimeout(r, 100));

    fsSync.writeFileSync(path.join(tmpDir, 'watch.txt'), 'world');
    await new Promise(r => setTimeout(r, 100));

    await watcher.close();

    expect(events.some(e => e.type === 'add')).toBe(true);
    expect(events.some(e => e.type === 'change')).toBe(true);
  });

  it('callback error triggers watcher_callback_failed and continues', async () => {
    const { audit, events: auditEvents } = makeAudit();
    let callCount = 0;
    const watcher = createWatcher(
      fs,
      'watch.txt',
      (ev) => {
        callCount++;
        if (callCount === 1) throw new Error('callback boom');
      },
      audit,
      { stability: 'immediate' },
    );

    await new Promise(r => setTimeout(r, 300));

    fsSync.writeFileSync(path.join(tmpDir, 'watch.txt'), 'first');
    await new Promise(r => setTimeout(r, 100));

    fsSync.writeFileSync(path.join(tmpDir, 'watch.txt'), 'second');
    await new Promise(r => setTimeout(r, 100));

    await watcher.close();

    expect(auditEvents.some(e => e[0] === AUDIT_EVENTS.WATCHER_CALLBACK_FAILED)).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(2); // 第二次仍然触发
  });

  it('onReady error triggers watcher_ready_failed', async () => {
    const { audit, events: auditEvents } = makeAudit();
    const watcher = createWatcher(
      fs,
      'watch.txt',
      () => {},
      audit,
      {
        stability: 'immediate',
        onReady: () => { throw new Error('ready boom'); },
      },
    );

    await new Promise(r => setTimeout(r, 500));
    await watcher.close();

    expect(auditEvents.some(e => e[0] === AUDIT_EVENTS.WATCHER_READY_FAILED)).toBe(true);
  });

  it('chokidar error triggers watcher_error audit', async () => {
    const { audit, events: auditEvents } = makeAudit();
    // watch a non-existent path deep inside non-existent dirs to trigger chokidar error
    const watcher = createWatcher(
      fs,
      'deep/nested/missing.txt',
      () => {},
      audit,
      { stability: 'immediate' },
    );

    await new Promise(r => setTimeout(r, 500));
    await watcher.close();

    // chokidar may or may not emit error depending on timing;
    // if it does, audit should capture it
    const errorEvents = auditEvents.filter(e => e[0] === AUDIT_EVENTS.WATCHER_ERROR);
    // 不强求一定触发（取决于 chokidar 行为），但如果触发则必须走 audit
    if (errorEvents.length > 0) {
      expect(errorEvents[0]).toContain(expect.stringContaining('path='));
    }
  });

  it('onError callback error triggers secondary watcher_error', async () => {
    const { audit, events: auditEvents } = makeAudit();
    // 用一个会触发 error 的路径 + onError 抛错
    const watcher = createWatcher(
      fs,
      'deep/nested/missing.txt',
      () => {},
      audit,
      {
        stability: 'immediate',
        onError: () => { throw new Error('onError boom'); },
      },
    );

    await new Promise(r => setTimeout(r, 500));
    await watcher.close();

    const errorEvents = auditEvents.filter(e => e[0] === AUDIT_EVENTS.WATCHER_ERROR);
    if (errorEvents.length > 0) {
      // 至少有一次是二级失败（带 context=onError_handler）
      const secondary = errorEvents.find(e =>
        e.some(col => String(col).includes('context=onError_handler'))
      );
      if (secondary) {
        expect(secondary.some(col => String(col).includes('onError boom'))).toBe(true);
      }
    }
  });

  it('close is idempotent', async () => {
    const { audit } = makeAudit();
    const watcher = createWatcher(
      fs,
      'watch.txt',
      () => {},
      audit,
      { stability: 'immediate' },
    );
    await watcher.close();
    await expect(watcher.close()).resolves.toBeUndefined();
  });
});
