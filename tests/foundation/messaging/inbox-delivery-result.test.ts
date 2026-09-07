/**
 * Phase 1782: InboxReader.drainAndDeliver() typed batch outcome (InboxDeliveryResult).
 *
 * 覆盖 claim/move 中途失败的 typed 传播（不再压平为完整成功、不再以异常穿越 drain 边界）：
 * - complete：空 pending / 全部 entries claim + move 成功
 * - partial_failure stage='move'：首个 inflight move 失败即停止，携带 entry identity
 *   + 原始 error + 已 claim entries/handles；失败及后续 entries 留 pending/ 幂等重试
 * - partial_failure stage='claim'：pending list 失败 / malformed quarantine move 失败，
 *   尚未 claim 任何 entry，保留原始 error（entry identity 可得时携带）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxReader, InboxWriter, InboxListFailed, InboxMoveFailed } from '../../../src/foundation/messaging/index.js';
import { makeInboxPath } from '../../../src/foundation/messaging/index.js';
import type { InboxDeliveryResult, Priority } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { INBOX_PENDING_DIR } from '../../../src/foundation/messaging/dirs.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

function makeAudit() {
  const events: Array<[string, ...unknown[]]> = [];
  return {
    audit: { write: (t: string, ...c: unknown[]) => { events.push([t, ...c]); }, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s },
    events,
  };
}

function makeErrno(code: string, message: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('InboxReader.drainAndDeliver() InboxDeliveryResult (phase 1782)', () => {
  let root: string;
  let pendingDir: string;
  let doneDir: string;
  let failedDir: string;
  let inflightDir: string;
  let fs: NodeFileSystem;
  let writer: InboxWriter;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `inbox-delivery-result-${randomUUID()}`);
    pendingDir = path.join(root, 'inbox/pending');
    doneDir = path.join(root, 'inbox/done');
    failedDir = path.join(root, 'inbox/failed');
    inflightDir = path.join(root, 'inbox/inflight');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.mkdir(doneDir, { recursive: true });
    await fsAsync.mkdir(failedDir, { recursive: true });
    await fsAsync.mkdir(inflightDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
    const { audit } = makeAudit();
    writer = InboxWriter.__internal_create(fs, makeInboxPath(INBOX_PENDING_DIR), audit);
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeReader(overrideFs?: NodeFileSystem) {
    const { audit, events } = makeAudit();
    const reader = new InboxReader(pendingDir, doneDir, failedDir, overrideFs ?? fs, audit, inflightDir);
    return { reader, events };
  }

  /** Proxy fs overriding one method; all others delegate (phase 931 既有 pattern)。 */
  function wrapFs(overrides: Record<string, unknown>): NodeFileSystem {
    return new Proxy(fs, {
      get(target, prop) {
        if (prop in overrides) return overrides[prop as string];
        return (target as unknown as Record<string, unknown>)[prop as string];
      },
    }) as unknown as NodeFileSystem;
  }

  async function writeMsg(id: string, priority: Priority = 'normal') {
    await writer.write({
      id,
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: `body-${id}`,
      priority,
      timestamp: new Date().toISOString(),
    });
  }

  const pendingFiles = () => fsAsync.readdir(pendingDir);
  const inflightFiles = () => fsAsync.readdir(inflightDir);

  it('complete: 空 pending → kind=complete 零交付', async () => {
    const { reader } = makeReader();
    const result = await reader.drainAndDeliver();
    expect(result).toEqual({
      kind: 'complete',
      entries: [],
      handles: [],
      transientErrors: 0,
      permanentErrors: 0,
    } satisfies InboxDeliveryResult);
  });

  it('complete: 全部 entries move 到 inflight/ → kind=complete + handles', async () => {
    await writeMsg('msg-1');
    await writeMsg('msg-2');
    const { reader } = makeReader();
    const result = await reader.drainAndDeliver();
    expect(result.kind).toBe('complete');
    expect(result.entries).toHaveLength(2);
    expect(result.handles).toHaveLength(2);
    expect(await pendingFiles()).toHaveLength(0);
    expect(await inflightFiles()).toHaveLength(2);
  });

  it('partial_failure stage=move: 首个 move 失败 → entry identity + 原始 error，文件留 pending/，重试幂等', async () => {
    await writeMsg('msg-move');
    const boom = makeErrno('EIO', 'inflight move failed');
    let fail = true;
    let failedSrc = '';
    const errFs = wrapFs({
      move: async (src: string, dst: string) => {
        if (fail && path.dirname(dst) === inflightDir) {
          failedSrc = src;
          throw boom;
        }
        return fs.move(src, dst);
      },
    });
    const { reader, events } = makeReader(errFs);

    const first = await reader.drainAndDeliver();
    expect(first.kind).toBe('partial_failure');
    if (first.kind !== 'partial_failure') throw new Error('unreachable');
    expect(first.stage).toBe('move');
    expect(first.entry).toBe(path.basename(failedSrc));
    expect(first.error).toBe(boom);
    expect(first.entries).toHaveLength(0);
    expect(first.handles).toHaveLength(0);
    // 未处理 entry 留在 pending/（不丢）；inflight/ 无残留（不重复 claim）
    expect(await pendingFiles()).toHaveLength(1);
    expect(await inflightFiles()).toHaveLength(0);
    // 既有 messaging 层 audit 保留
    expect(events.some(e => e[0] === MESSAGING_AUDIT_EVENTS.INBOX_MOVE_FAILED
      && e.slice(1).some(c => String(c).includes('deliver_inflight')))).toBe(true);

    // 故障消除后重试：同一文件正常交付，无重复无丢失
    fail = false;
    const second = await reader.drainAndDeliver();
    expect(second.kind).toBe('complete');
    expect(second.entries).toHaveLength(1);
    expect(await pendingFiles()).toHaveLength(0);
    expect(await inflightFiles()).toHaveLength(1);
  });

  it('partial_failure stage=move: 第二条 move 失败 → 已 claim entry 保留 evidence 且 handle 仍可 ack', async () => {
    // priority 排序保证 claim 顺序：high 先、low 后
    await writeMsg('msg-first', 'high');
    await writeMsg('msg-second', 'low');
    const boom = makeErrno('ENOSPC', 'no space');
    let moveCount = 0;
    const errFs = wrapFs({
      move: async (src: string, dst: string) => {
        if (path.dirname(dst) === inflightDir) {
          moveCount += 1;
          if (moveCount === 2) throw boom;
        }
        return fs.move(src, dst);
      },
    });
    const { reader } = makeReader(errFs);

    const result = await reader.drainAndDeliver();
    expect(result.kind).toBe('partial_failure');
    if (result.kind !== 'partial_failure') throw new Error('unreachable');
    expect(result.stage).toBe('move');
    expect(result.error).toBe(boom);
    // 已 claim 的 high entry 保留在 result（不压平、不丢 evidence）
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].message.id).toBe('msg-first');
    expect(result.handles).toHaveLength(1);
    // entry identity = 失败 entry 原始文件名（writer 文件名含 priority infix）
    expect(result.entry).toContain('_low_');
    // 失败 entry 留在 pending/；已 claim entry 在 inflight/
    const pendingLeft = await pendingFiles();
    expect(pendingLeft).toHaveLength(1);
    expect(pendingLeft[0]).toBe(result.entry);
    expect(await inflightFiles()).toHaveLength(1);
    // 已交付 handle 结算不受 partial failure 影响
    await reader.ack(result.handles[0]);
    expect(await inflightFiles()).toHaveLength(0);
    expect(await fsAsync.readdir(doneDir)).toHaveLength(1);
  });

  it('partial_failure stage=claim: pending list 失败 → 无 entry identity、保留 InboxListFailed 原始 error', async () => {
    await writeMsg('msg-list');
    const boom = makeErrno('EACCES', 'list denied');
    const errFs = wrapFs({
      list: async (dir: string) => {
        if (dir === pendingDir) throw boom;
        return fs.list(dir);
      },
    });
    const { reader } = makeReader(errFs);

    const result = await reader.drainAndDeliver();
    expect(result.kind).toBe('partial_failure');
    if (result.kind !== 'partial_failure') throw new Error('unreachable');
    expect(result.stage).toBe('claim');
    expect(result.entry).toBeUndefined();
    expect(result.error).toBeInstanceOf(InboxListFailed);
    expect((result.error as InboxListFailed).cause).toBe(boom);
    expect(result.entries).toHaveLength(0);
    // 未 claim 任何 entry：pending/ 原样保留
    expect(await pendingFiles()).toHaveLength(1);
    expect(await inflightFiles()).toHaveLength(0);
  });

  it('partial_failure stage=claim: malformed quarantine move 失败 → InboxMoveFailed 原始 error + entry identity、entry 留 pending/', async () => {
    const malformedPath = path.join(pendingDir, 'malformed.md');
    await fsAsync.writeFile(malformedPath, '---\ntype: normal\nid: bad-msg\n(no closing fence)');
    const boom = makeErrno('EIO', 'failed-dir move failed');
    const errFs = wrapFs({
      move: async (src: string, dst: string) => {
        if (path.dirname(dst) === failedDir) throw boom;
        return fs.move(src, dst);
      },
    });
    const { reader } = makeReader(errFs);

    const result = await reader.drainAndDeliver();
    expect(result.kind).toBe('partial_failure');
    if (result.kind !== 'partial_failure') throw new Error('unreachable');
    expect(result.stage).toBe('claim');
    // markFailed 包装为 InboxMoveFailed（op=failed）→ claim 阶段也可保留 entry identity
    expect(result.error).toBeInstanceOf(InboxMoveFailed);
    expect((result.error as InboxMoveFailed).cause).toBe(boom);
    expect(result.entry).toBe('malformed.md');
    expect(result.entries).toHaveLength(0);
    // quarantine move 失败的 malformed 文件留 pending/（不静默丢失）
    expect(await pendingFiles()).toContain('malformed.md');
    expect(await fsAsync.readdir(failedDir)).toHaveLength(0);
  });
});
