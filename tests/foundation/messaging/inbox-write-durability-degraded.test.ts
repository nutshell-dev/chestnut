/**
 * Phase 1869 Step D: 交付证据边界 —— inbox 写入耐久性降级不静默。
 *
 * 契约：writeAtomic/writeAtomicSync 返回非 durable
 * （committed_platform_limited / committed_durability_unknown）时，写入已提交
 * （不回滚、不重写），但必须审计留证（inbox_write_durability_degraded）；
 * 正常流程照常（resolve / INBOX_WRITTEN）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: {
      write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    },
    events,
  };
}

const MSG = {
  id: 'msg-1',
  type: 'user_chat',
  from: 'claw-a',
  to: '',
  content: 'hello',
  priority: 'normal' as const,
  timestamp: new Date().toISOString(),
};

describe('inbox 写入耐久性降级留证 (phase 1869 Step D)', () => {
  let root: string;
  let pendingDir: string;
  let fs: NodeFileSystem;
  let writer: InboxWriter;
  let events: Array<[string, ...unknown[]]>;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `inbox-durability-${randomUUID()}`);
    pendingDir = path.join(root, 'inbox/pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const made = makeAudit();
    events = made.events;
    writer = InboxWriter.__internal_create(fs, makeInboxPath(pendingDir), made.audit, MESSAGING_WRITER_LIMITS_DEFAULT);
  });

  const CLEANUP_TIMEOUT_MS = 2000;
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.race([
      fsAsync.rm(root, { recursive: true, force: true }),
      new Promise(r => setTimeout(r, CLEANUP_TIMEOUT_MS)),
    ]).catch(() => { /* silent: cleanup timeout or fs error */ });
  });

  function durabilityEvents() {
    return events.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITE_DURABILITY_DEGRADED);
  }

  it('write(): committed_platform_limited → 审计留证 + 写入照常（resolve、INBOX_WRITTEN、文件在）', async () => {
    const degradedErr = Object.assign(new Error('dir fsync EINVAL'), { code: 'EINVAL' });
    const realWriteAtomic = fs.writeAtomic.bind(fs);
    vi.spyOn(fs, 'writeAtomic').mockImplementationOnce(async (p, c) => {
      await realWriteAtomic(p, c);  // rename 已提交
      return { kind: 'committed_platform_limited', error: degradedErr };
    });

    await expect(writer.write(MSG)).resolves.toBeUndefined();

    const degraded = durabilityEvents();
    expect(degraded).toHaveLength(1);
    expect(degraded[0].some(c => String(c) === 'durability=committed_platform_limited')).toBe(true);
    expect(degraded[0].some(c => String(c).includes('dir fsync EINVAL'))).toBe(true);
    expect(degraded[0].some(c => String(c) === 'id=msg-1')).toBe(true);
    // 写入照常：INBOX_WRITTEN 发出 + 文件真实落在 pending/
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN)).toBe(true);
    const files = await fsAsync.readdir(pendingDir);
    expect(files).toHaveLength(1);
  });

  it('write(): durable → 无降级审计（正常路径零漂移）', async () => {
    await writer.write(MSG);
    expect(durabilityEvents()).toHaveLength(0);
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_WRITTEN)).toBe(true);
  });

  it('writeSync(): committed_durability_unknown → 审计留证 + 返回文件名、文件在', () => {
    const degradedErr = Object.assign(new Error('dir fsync EIO'), { code: 'EIO' });
    const realWriteAtomicSync = fs.writeAtomicSync.bind(fs);
    vi.spyOn(fs, 'writeAtomicSync').mockImplementationOnce((p, c) => {
      realWriteAtomicSync(p, c);
      return { kind: 'committed_durability_unknown', error: degradedErr };
    });

    const filename = writer.writeSync({ type: 'user_chat', source: 'claw-a', body: 'sync hello' });

    expect(filename.endsWith('.md')).toBe(true);
    const degraded = durabilityEvents();
    expect(degraded).toHaveLength(1);
    expect(degraded[0].some(c => String(c) === 'durability=committed_durability_unknown')).toBe(true);
    expect(degraded[0].some(c => String(c).includes('dir fsync EIO'))).toBe(true);
    expect(require('fs').readdirSync(pendingDir)).toHaveLength(1);
  });

  it('writeSync(): durable → 无降级审计', () => {
    writer.writeSync({ type: 'user_chat', source: 'claw-a', body: 'sync hello' });
    expect(durabilityEvents()).toHaveLength(0);
  });
});
