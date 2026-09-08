/**
 * Phase 1804: Messaging-owned pending cleanup（Daemon heartbeat 物理删除治理）。
 *
 * - typed identity：按解码 meta.type 匹配，不解析文件名 substring。
 * - 误删防护：仅 pending/ 且 type 精确匹配；文件名含 '_heartbeat_' 的非 heartbeat 不删。
 * - partial failure：解码失败/删除失败 → failure evidence + 保留文件；list 故障 → partial。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  createInboxReader,
  InboxWriter,
  makeInboxPath,
  INBOX_PENDING_DIR,
} from '../../../src/foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { encodeInbox, decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';

describe('cleanupPendingByType (phase 1804)', () => {
  let root: string;
  let pendingDir: string;
  let fs: NodeFileSystem;
  let writer: InboxWriter;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `inbox-cleanup-${randomUUID()}`);
    pendingDir = path.join(root, 'inbox', 'pending');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit } = makeAudit();
    writer = InboxWriter.__internal_create(fs, makeInboxPath(INBOX_PENDING_DIR), audit, MESSAGING_WRITER_LIMITS_DEFAULT);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeReader(overrideFs?: NodeFileSystem) {
    const { audit, events } = makeAudit();
    const reader = createInboxReader(overrideFs ?? fs, audit, path.join(root, 'inbox'));
    return { reader, events };
  }

  function wrapFs(overrides: Record<string, unknown>): NodeFileSystem {
    return new Proxy(fs, {
      get(target, prop) {
        if (prop in overrides) return overrides[prop as string];
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    }) as unknown as NodeFileSystem;
  }

  async function writeMsg(id: string, type: string) {
    await writer.write({
      id, type, from: 'motion', to: 'motion',
      content: `body-${id}`, priority: 'low', timestamp: new Date().toISOString(),
    });
  }

  /** 手写 legacy 命名文件（Daemon 旧时代 _heartbeat_ 物理文件名，writer 现不嵌 id）。 */
  async function writeLegacyNamed(filename: string, id: string, type: string) {
    const wire = encodeInbox({
      id, type, from: 'motion', to: 'motion',
      content: `body-${id}`, priority: 'low', timestamp: new Date().toISOString(),
    });
    await fsAsync.writeFile(path.join(pendingDir, filename), wire);
  }

  const pendingFiles = () => fsAsync.readdir(pendingDir);
  const decodeId = async (name: string) =>
    decodeInbox(await fsAsync.readFile(path.join(pendingDir, name), 'utf8')).id;

  it('complete：仅删 pending 中 type=heartbeat，其他类型保留', async () => {
    await writeMsg('hb-1', 'heartbeat');
    await writeMsg('hb-2', 'heartbeat');
    await writeMsg('q-1', 'question');
    const { reader } = makeReader();
    const result = await reader.cleanupPendingByType('heartbeat');
    expect(result).toEqual({ kind: 'complete', removed: 2 });
    const rest = await pendingFiles();
    expect(rest).toHaveLength(1);
    expect(await decodeId(rest[0])).toBe('q-1');
  });

  it('typed identity：文件名无 _heartbeat_ 的 heartbeat 照删；文件名含 _heartbeat_ 的非 heartbeat 保留', async () => {
    await writeMsg('plainid', 'heartbeat');                              // 文件名无 _heartbeat_ 但 type 是
    await writeLegacyNamed('legacy_heartbeat_abc.md', 'legacy-1', 'message');  // 文件名含 _heartbeat_ 但 type 不是
    const { reader } = makeReader();
    const result = await reader.cleanupPendingByType('heartbeat');
    expect(result).toEqual({ kind: 'complete', removed: 1 });
    const rest = await pendingFiles();
    expect(rest).toEqual(['legacy_heartbeat_abc.md']);
    expect(await decodeId(rest[0])).toBe('legacy-1');
  });

  it('损坏消息（decode 失败）→ partial + 文件保留 + failure evidence', async () => {
    await writeMsg('hb-1', 'heartbeat');
    await fsAsync.writeFile(path.join(pendingDir, 'corrupt.md'), '---\n[broken frontmatter\n---\n');
    const { reader } = makeReader();
    const result = await reader.cleanupPendingByType('heartbeat');
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new Error('unreachable');
    expect(result.removed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].error).toContain('meta decode failed');
    expect(result.failures[0].messageId).toBeUndefined();  // 解码失败无 identity
    expect(await pendingFiles()).toContain('corrupt.md');  // 保留，不猜测
  });

  it('删除失败 → partial + messageId evidence + 文件保留', async () => {
    await writeMsg('hb-stuck', 'heartbeat');
    const boom = new Error('EIO delete denied');
    const errFs = wrapFs({ delete: async () => { throw boom; } });
    const { reader } = makeReader(errFs);
    const result = await reader.cleanupPendingByType('heartbeat');
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new Error('unreachable');
    expect(result.removed).toBe(0);
    expect(result.failures[0].messageId).toBe('hb-stuck');
    expect(result.failures[0].error).toContain('EIO');
    expect(await pendingFiles()).toHaveLength(1);
  });

  it('pending 目录不存在（ENOENT）→ complete removed=0', async () => {
    await fsAsync.rm(path.join(root, 'inbox'), { recursive: true, force: true });
    const { reader } = makeReader();
    expect(await reader.cleanupPendingByType('heartbeat')).toEqual({ kind: 'complete', removed: 0 });
  });

  it('list 故障（非 ENOENT）→ partial removed=0 + inbox_list_failed audit', async () => {
    const boom = Object.assign(new Error('EACCES list denied'), { code: 'EACCES' });
    const errFs = wrapFs({ list: async () => { throw boom; } });
    const { reader, events } = makeReader(errFs);
    const result = await reader.cleanupPendingByType('heartbeat');
    expect(result.kind).toBe('partial');
    if (result.kind !== 'partial') throw new Error('unreachable');
    expect(result.removed).toBe(0);
    expect(result.failures[0].error).toContain('EACCES');
    const listFailed = events.filter(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_LIST_FAILED);
    expect(listFailed).toHaveLength(1);
    expect(listFailed[0].join('\t')).toContain('op=cleanup');
  });
});
