/**
 * Phase 1285: InboxReader ack/nack/reconcile protocol reverse tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { InboxReader, InboxWriter } from '../../../src/foundation/messaging/index.js';
import { makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { MESSAGING_AUDIT_EVENTS } from '../../../src/foundation/messaging/audit-events.js';
import { INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR } from '../../../src/foundation/messaging/dirs.js';

describe('InboxReader ack/nack/reconcile protocol (phase 1285)', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let auditCalls: Array<{ type: string; cols: string[] }>;
  let reader: InboxReader;
  let writer: InboxWriter;

  beforeEach(async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    testDir = path.join(tmpdir(), `inbox-ack-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
    auditCalls = [];
    const audit = {
      write(type: string, ...cols: (string | number)[]) {
        auditCalls.push({ type, cols: cols.map(String) });
      },
    };
    writer = InboxWriter.__internal_create(nfs, makeInboxPath(INBOX_PENDING_DIR), audit);
    reader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      audit,
    );
    await reader.init();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  async function writeMsg(id: string, body: string) {
    await writer.write({
      id,
      type: 'message',
      from: 'sender',
      to: 'claw',
      content: body,
      priority: 'normal',
      timestamp: new Date().toISOString(),
    });
  }

  // ─── Case 1: drainAndDeliver moves files to inflight ──────────────────────
  it('drainAndDeliver moves pending files to inflight/', async () => {
    await writeMsg('msg-1', 'hello');

    const { entries, handles } = await reader.drainAndDeliver();

    expect(entries).toHaveLength(1);
    expect(handles).toHaveLength(1);
    expect(path.basename(handles[0].filePath)).toBe(path.basename(entries[0].filePath));
    expect(handles[0].filePath).toContain('/inflight/');

    const pendingFiles = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(pendingFiles.filter(f => f.endsWith('.md'))).toHaveLength(0);

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(1);
  });

  // ─── Case 2: ack moves inflight to done ───────────────────────────────────
  it('ack moves inflight file to done/', async () => {
    await writeMsg('msg-1', 'hello');
    const { handles } = await reader.drainAndDeliver();

    await reader.ack(handles[0]);

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(0);

    const doneFiles = await fs.readdir(path.join(testDir, 'inbox', 'done'));
    expect(doneFiles).toHaveLength(1);
    expect(doneFiles[0]).toMatch(/^\d+_[a-f0-9]{8}_.+\.md$/);
  });

  // ─── Case 3: nack moves inflight back to pending ──────────────────────────
  it('nack moves inflight file back to pending/', async () => {
    await writeMsg('msg-1', 'hello');
    const { handles } = await reader.drainAndDeliver();

    await reader.nack(handles[0], 'user_interrupt');

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(0);

    const pendingFiles = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(pendingFiles.filter(f => f.endsWith('.md'))).toHaveLength(1);

    const nackAudit = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_NACK);
    expect(nackAudit).toHaveLength(1);
    expect(nackAudit[0].cols.some(c => c.includes('reason=user_interrupt'))).toBe(true);
  });

  // ─── Case 4: init reconcile inflight→pending on startup ───────────────────
  it('init() reconciles orphaned inflight files back to pending', async () => {
    await writeMsg('msg-1', 'hello');
    // manually move to inflight to simulate crash before ack
    // Phase 930: inflight filenames carry a claim lease; use a dead PID so it is reclaimed.
    const src = path.join(testDir, 'inbox', 'pending');
    const dst = path.join(testDir, 'inbox', 'inflight');
    const files = await fs.readdir(src);
    for (const f of files) {
      const inflightPath = path.join(dst, `99999_0_${f}`);
      await fs.rename(path.join(src, f), inflightPath);
      // Phase 932: startTime=0 uses mtime lease; backdate to exceed STALE_THRESHOLD_MS.
      const oldMtime = new Date(Date.now() - 6 * 60 * 1000);
      await fs.utimes(inflightPath, oldMtime, oldMtime);
    }

    // create new reader → init() should reconcile
    const freshAuditCalls: Array<{ type: string; cols: string[] }> = [];
    const freshAudit = {
      write(type: string, ...cols: (string | number)[]) {
        freshAuditCalls.push({ type, cols: cols.map(String) });
      },
    };
    const freshReader = new InboxReader(
      path.join(testDir, 'inbox', 'pending'),
      path.join(testDir, 'inbox', 'done'),
      path.join(testDir, 'inbox', 'failed'),
      nfs,
      freshAudit,
    );
    await freshReader.init();

    const pendingFiles = await fs.readdir(path.join(testDir, 'inbox', 'pending'));
    expect(pendingFiles.filter(f => f.endsWith('.md'))).toHaveLength(1);

    const inflightFiles = await fs.readdir(path.join(testDir, 'inbox', 'inflight'));
    expect(inflightFiles).toHaveLength(0);

    const reconcileAudit = freshAuditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RECONCILE);
    expect(reconcileAudit).toHaveLength(1);
    expect(reconcileAudit[0].cols.some(c => c.includes('reverted_count=1'))).toBe(true);
  });

  // ─── Case 5: drainAndDeliver on empty inbox returns empty ─────────────────
  it('drainAndDeliver on empty pending returns empty', async () => {
    const { entries, handles } = await reader.drainAndDeliver();
    expect(entries).toHaveLength(0);
    expect(handles).toHaveLength(0);
  });

  // ─── Phase 1020: restore-to-pending conflict detection ────────────────────
  describe('restore conflict detection (phase 1020)', () => {
    const pendingDir = () => path.join(testDir, 'inbox', 'pending');
    const inflightDir = () => path.join(testDir, 'inbox', 'inflight');
    const doneDir = () => path.join(testDir, 'inbox', 'done');
    const failedDir = () => path.join(testDir, 'inbox', 'failed');

    async function mdFiles(dir: string): Promise<string[]> {
      return (await fs.readdir(dir)).filter(f => f.endsWith('.md'));
    }

    // 把 pending 中的文件复制一份到 inflight、伪装成 stale claim（startTime=0 →
    // mtime lease，backdate 超 STALE_THRESHOLD_MS）
    async function plantStaleInflight(name: string, content: string): Promise<void> {
      const inflightPath = path.join(inflightDir(), `99999_0_${name}`);
      await fs.writeFile(inflightPath, content);
      const oldMtime = new Date(Date.now() - 6 * 60 * 1000);
      await fs.utimes(inflightPath, oldMtime, oldMtime);
    }

    function makeFreshReader(): { reader: InboxReader; calls: Array<{ type: string; cols: string[] }> } {
      const calls: Array<{ type: string; cols: string[] }> = [];
      const audit = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push({ type, cols: cols.map(String) });
        },
      };
      return {
        reader: new InboxReader(pendingDir(), doneDir(), failedDir(), nfs, audit),
        calls,
      };
    }

    // ─── 反向测试 1: reconcile 同名同内容 → dedupe 归档 done ────────────────
    it('reconcile: stale inflight + same-name same-content pending → archive to done, pending kept', async () => {
      await writeMsg('msg-recon-dup', 'hello dup');
      const [name] = await mdFiles(pendingDir());
      const content = await fs.readFile(path.join(pendingDir(), name), 'utf-8');
      await plantStaleInflight(name, content);

      const { reader: freshReader, calls } = makeFreshReader();
      await freshReader.init();

      // pending 保留原文件、内容未被覆盖
      expect(await mdFiles(pendingDir())).toEqual([name]);
      expect(await fs.readFile(path.join(pendingDir(), name), 'utf-8')).toBe(content);
      // inflight 清空；重复副本归档到 done/；failed/ 无新增
      expect(await mdFiles(inflightDir())).toHaveLength(0);
      expect(await mdFiles(doneDir())).toHaveLength(1);
      expect(await mdFiles(failedDir())).toHaveLength(0);
      // audit: INBOX_DEDUPED、无 INBOX_RESTORE_CONFLICT
      expect(calls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED)).toBe(true);
      expect(calls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RESTORE_CONFLICT)).toBe(false);
    });

    // ─── 反向测试 2: reconcile 同名异内容 → 入 failed/DLQ ───────────────────
    it('reconcile: stale inflight + same-name different-content pending → inflight copy to failed, pending kept', async () => {
      await writeMsg('msg-recon-conflict', 'hello conflict');
      const [name] = await mdFiles(pendingDir());
      const pendingContent = await fs.readFile(path.join(pendingDir(), name), 'utf-8');
      const inflightContent = pendingContent + '\n<!-- diverged -->\n';
      await plantStaleInflight(name, inflightContent);

      const { reader: freshReader, calls } = makeFreshReader();
      await freshReader.init();

      // pending 保留原内容
      expect(await mdFiles(pendingDir())).toEqual([name]);
      expect(await fs.readFile(path.join(pendingDir(), name), 'utf-8')).toBe(pendingContent);
      // inflight 清空；冲突副本入 failed/（内容 = inflight 版）；done/ 无新增
      expect(await mdFiles(inflightDir())).toHaveLength(0);
      const failedFiles = await mdFiles(failedDir());
      expect(failedFiles).toHaveLength(1);
      expect(await fs.readFile(path.join(failedDir(), failedFiles[0]), 'utf-8')).toBe(inflightContent);
      expect(await mdFiles(doneDir())).toHaveLength(0);
      // audit: INBOX_RESTORE_CONFLICT op=reconcile、无 INBOX_DEDUPED
      const conflict = calls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RESTORE_CONFLICT);
      expect(conflict).toHaveLength(1);
      expect(conflict[0].cols.some(c => c === 'op=reconcile')).toBe(true);
      expect(calls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED)).toBe(false);
    });

    // ─── 反向测试 3: nack 同名同内容 → dedupe 归档 done ─────────────────────
    it('nack: pending already has same-name same-content file → archive to done, pending kept', async () => {
      await writeMsg('msg-nack-dup', 'hello nack dup');
      const { handles } = await reader.drainAndDeliver();
      const handle = handles[0];
      const inflightContent = await fs.readFile(handle.filePath, 'utf-8');
      // 模拟 pending 中已存在同名同内容文件（另一投递路径已送达）
      const targetPath = path.join(pendingDir(), handle.originalFileName);
      await fs.writeFile(targetPath, inflightContent);

      await reader.nack(handle, 'test_dup');

      // pending 保留原文件、内容未被覆盖
      expect(await mdFiles(pendingDir())).toEqual([handle.originalFileName]);
      expect(await fs.readFile(targetPath, 'utf-8')).toBe(inflightContent);
      // inflight 清空；重复副本归档到 done/；failed/ 无新增
      expect(await mdFiles(inflightDir())).toHaveLength(0);
      expect(await mdFiles(doneDir())).toHaveLength(1);
      expect(await mdFiles(failedDir())).toHaveLength(0);
      // audit: INBOX_DEDUPED；dedupe 路径不再 emit INBOX_NACK
      expect(auditCalls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED)).toBe(true);
      expect(auditCalls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_NACK)).toBe(false);
    });

    // ─── 反向测试 4: nack 同名异内容 → 入 failed/DLQ ────────────────────────
    it('nack: pending already has same-name different-content file → inflight copy to failed, pending kept', async () => {
      await writeMsg('msg-nack-conflict', 'hello nack conflict');
      const { handles } = await reader.drainAndDeliver();
      const handle = handles[0];
      const inflightContent = await fs.readFile(handle.filePath, 'utf-8');
      const pendingContent = inflightContent + '\n<!-- diverged -->\n';
      // 模拟 pending 中已存在同名但内容不同的文件
      const targetPath = path.join(pendingDir(), handle.originalFileName);
      await fs.writeFile(targetPath, pendingContent);

      await reader.nack(handle, 'test_conflict');

      // pending 保留原内容
      expect(await mdFiles(pendingDir())).toEqual([handle.originalFileName]);
      expect(await fs.readFile(targetPath, 'utf-8')).toBe(pendingContent);
      // inflight 清空；冲突副本入 failed/（内容 = inflight 版）；done/ 无新增
      expect(await mdFiles(inflightDir())).toHaveLength(0);
      const failedFiles = await mdFiles(failedDir());
      expect(failedFiles).toHaveLength(1);
      expect(await fs.readFile(path.join(failedDir(), failedFiles[0]), 'utf-8')).toBe(inflightContent);
      expect(await mdFiles(doneDir())).toHaveLength(0);
      // audit: INBOX_RESTORE_CONFLICT op=nack、无 INBOX_DEDUPED / INBOX_NACK
      const conflict = auditCalls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RESTORE_CONFLICT);
      expect(conflict).toHaveLength(1);
      expect(conflict[0].cols.some(c => c === 'op=nack')).toBe(true);
      expect(auditCalls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED)).toBe(false);
      expect(auditCalls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_NACK)).toBe(false);
    });
  });
});
