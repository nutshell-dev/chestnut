/**
 * Phase 1781: InboxReader.init() typed recovery outcome (InboxInitResult).
 *
 * 覆盖 `_reconcileInflight` 各失败出口的 typed 传播：
 * - ready：零恢复 / stale claim 恢复计数
 * - degraded stage='list'：inflight list 失败（保留原始 error，无 entry identity）
 * - degraded stage='read'：entry stat 失败（保留 entry identity + 原始 error，其余 entry 继续处置）
 * - degraded stage='move'：restore move 失败（entry 留 inflight/ 原处，不伪造 ready）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxReader } from '../../../src/foundation/messaging/index.js';
import type { InboxInitResult } from '../../../src/foundation/messaging/index.js';
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

describe('InboxReader.init() InboxInitResult (phase 1781)', () => {
  let root: string;
  let pendingDir: string;
  let doneDir: string;
  let failedDir: string;
  let inflightDir: string;
  let fs: NodeFileSystem;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = path.join(tmpdir(), `inbox-init-result-${randomUUID()}`);
    pendingDir = path.join(root, 'inbox/pending');
    doneDir = path.join(root, 'inbox/done');
    failedDir = path.join(root, 'inbox/failed');
    inflightDir = path.join(root, 'inbox/inflight');
    await fsAsync.mkdir(pendingDir, { recursive: true });
    await fsAsync.mkdir(doneDir, { recursive: true });
    await fsAsync.mkdir(failedDir, { recursive: true });
    await fsAsync.mkdir(inflightDir, { recursive: true });
    fs = new NodeFileSystem({ baseDir: root });
  });

  afterEach(async () => {
    await fsAsync.rm(root, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeReader(overrideFs?: NodeFileSystem) {
    const { audit, events } = makeAudit();
    const reader = new InboxReader(pendingDir, doneDir, failedDir, overrideFs ?? fs, audit, inflightDir);
    return { reader, events };
  }

  /** Stage a stale-claim inflight file (dead lease startTime=0 + old mtime). */
  async function stageStaleInflight(leaseName: string, content = 'body'): Promise<string> {
    const p = path.join(inflightDir, leaseName);
    await fsAsync.writeFile(p, content);
    const old = new Date(Date.now() - 10 * 60 * 1000);
    await fsAsync.utimes(p, old, old);
    return p;
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

  it('ready: empty inflight → recovered=0', async () => {
    const { reader } = makeReader();
    const result = await reader.init();
    expect(result).toEqual({ kind: 'ready', recovered: 0 } satisfies InboxInitResult);
  });

  it('ready: stale claim reclaimed → recovered=1, file back in pending', async () => {
    await stageStaleInflight('99999_0_msg-stale.md');
    const { reader, events } = makeReader();
    const result = await reader.init();
    expect(result).toEqual({ kind: 'ready', recovered: 1 } satisfies InboxInitResult);
    expect(await fsAsync.readdir(inflightDir)).toHaveLength(0);
    expect(await fsAsync.readdir(pendingDir)).toContain('msg-stale.md');
    expect(events.some(e => e[0] === 'inbox_reconcile')).toBe(true);
  });

  it('degraded stage=list: inflight list 失败 → 保留原始 error、无 entry identity', async () => {
    const boom = makeErrno('EACCES', 'permission denied');
    const errFs = wrapFs({
      list: async (dir: string) => {
        if (dir === inflightDir) throw boom;
        return fs.list(dir);
      },
    });
    const { reader, events } = makeReader(errFs);
    const result = await reader.init();
    expect(result.kind).toBe('degraded');
    if (result.kind !== 'degraded') throw new Error('unreachable');
    expect(result.stage).toBe('list');
    expect(result.entry).toBeUndefined();
    expect(result.error).toBe(boom);
    expect(result.recovered).toBe(0);
    expect(events.some(e => e[0] === 'inbox_list_failed')).toBe(true);
  });

  it('degraded stage=read: legacy entry stat 失败 → entry identity 保留，其余 entry 继续恢复', async () => {
    // legacy 格式（无 pid lease 前缀）走 mtime stat 分支
    const legacyPath = path.join(inflightDir, 'legacy-no-lease.md');
    await fsAsync.writeFile(legacyPath, 'legacy body');
    await stageStaleInflight('99999_0_msg-ok.md');
    const boom = makeErrno('EACCES', 'stat denied');
    const errFs = wrapFs({
      stat: async (p: string) => {
        if (p === legacyPath) throw boom;
        return fs.stat(p);
      },
    });
    const { reader, events } = makeReader(errFs);
    const result = await reader.init();
    expect(result.kind).toBe('degraded');
    if (result.kind !== 'degraded') throw new Error('unreachable');
    expect(result.stage).toBe('read');
    expect(result.entry).toBe('legacy-no-lease.md');
    expect(result.error).toBe(boom);
    // 其余 entry 不受连坐：stale claim 正常恢复
    expect(result.recovered).toBe(1);
    expect(await fsAsync.readdir(pendingDir)).toContain('msg-ok.md');
    // 失败 entry 留在 inflight/ 原处（不丢、不重复处置）
    expect(await fsAsync.readdir(inflightDir)).toContain('legacy-no-lease.md');
    expect(events.some(e => e[0] === 'inbox_move_failed' && e.slice(1).some(c => String(c).includes('reconcile_stat')))).toBe(true);
  });

  it('degraded stage=move: restore move 失败 → entry 留 inflight/，不伪造 ready', async () => {
    const staged = await stageStaleInflight('99999_0_msg-move.md');
    const boom = makeErrno('EIO', 'move failed');
    const errFs = wrapFs({
      move: async (src: string, dst: string) => {
        if (src === staged) throw boom;
        return fs.move(src, dst);
      },
    });
    const { reader, events } = makeReader(errFs);
    const result = await reader.init();
    expect(result.kind).toBe('degraded');
    if (result.kind !== 'degraded') throw new Error('unreachable');
    expect(result.stage).toBe('move');
    expect(result.entry).toBe('99999_0_msg-move.md');
    expect(result.error).toBe(boom);
    expect(result.recovered).toBe(0);
    // 未恢复 entry 保留在 inflight/ 原处
    expect(await fsAsync.readdir(inflightDir)).toContain('99999_0_msg-move.md');
    expect(await fsAsync.readdir(pendingDir)).not.toContain('msg-move.md');
    expect(events.some(e => e[0] === 'inbox_move_failed' && e.slice(1).some(c => String(c).includes('reconcile_pending')))).toBe(true);
  });

  it('degraded 后重试幂等：故障消除后再次 init → ready 且完成恢复', async () => {
    const staged = await stageStaleInflight('99999_0_msg-retry.md');
    const boom = makeErrno('EIO', 'transient move failure');
    let fail = true;
    const errFs = wrapFs({
      move: async (src: string, dst: string) => {
        if (fail && src === staged) throw boom;
        return fs.move(src, dst);
      },
    });
    const { reader } = makeReader(errFs);
    const first = await reader.init();
    expect(first.kind).toBe('degraded');
    fail = false;
    const second = await reader.init();
    expect(second).toEqual({ kind: 'ready', recovered: 1 } satisfies InboxInitResult);
    expect(await fsAsync.readdir(inflightDir)).toHaveLength(0);
    expect(await fsAsync.readdir(pendingDir)).toContain('msg-retry.md');
  });
});
