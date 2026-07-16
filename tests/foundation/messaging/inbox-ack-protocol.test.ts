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

  // ─── Phase 1021: stage file hardening ─────────────────────────────────────
  describe('stage file hardening (phase 1021)', () => {
    const pendingDir = () => path.join(testDir, 'inbox', 'pending');

    // ─── 反向测试 1: drainInbox 防御纵深跳过 .tmp_ 前缀 .md 文件 ────────────
    it('drainInbox defense-in-depth still skips .tmp_ .md files (recovery already handled in init)', async () => {
      await writeMsg('msg-normal', 'legit message');
      // 模拟旧版 stage 遗留（.md 结尾的 temp 文件）—— 内容合法、若被读取会被投递
      const normalName = (await fs.readdir(pendingDir())).find(f => f.endsWith('.md'))!;
      const legitContent = await fs.readFile(path.join(pendingDir(), normalName), 'utf-8');
      const tmpName = `.tmp_abc12345_${normalName}`;
      await fs.writeFile(path.join(pendingDir(), tmpName), legitContent);

      const { entries } = await reader.drainInbox();

      // 仅正常消息被处理；.tmp_ 文件被跳过（修复前会被 decode 并投递 → 重复投递）
      expect(entries).toHaveLength(1);
      expect(path.basename(entries[0].filePath)).toBe(normalName);
      // .tmp_ 文件原样留在 pending（skip ≠ consume）
      const remaining = await fs.readdir(pendingDir());
      expect(remaining).toContain(tmpName);
    });

    // ─── 反向测试 2: init() 恢复崩溃遗留 .staging 文件 ──────────────────────
    it('init() recovers crash-leftover .staging file to its original name', async () => {
      const originalName = '1700000000000_message_1_abcd1234.md';
      const stageName = `.tmp_abc12345_${originalName}.staging`;
      const stageContent = '---\nid: msg-staged\n---\nstaged body\n';
      await fs.writeFile(path.join(pendingDir(), stageName), stageContent);

      // 新 reader → init() 应恢复遗留 stage
      const calls: Array<{ type: string; cols: string[] }> = [];
      const audit = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push({ type, cols: cols.map(String) });
        },
      };
      const freshReader = new InboxReader(
        pendingDir(),
        path.join(testDir, 'inbox', 'done'),
        path.join(testDir, 'inbox', 'failed'),
        nfs,
        audit,
      );
      await freshReader.init();

      // target 恢复、stage 删除
      expect(await fs.readFile(path.join(pendingDir(), originalName), 'utf-8')).toBe(stageContent);
      const remaining = await fs.readdir(pendingDir());
      expect(remaining).not.toContain(stageName);
      // audit: INBOX_RECONCILE from=stage
      const reconcile = calls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RECONCILE);
      expect(reconcile).toHaveLength(1);
      expect(reconcile[0].cols.some(c => c === 'from=stage')).toBe(true);
      expect(reconcile[0].cols.some(c => c === 'reason=startup_stage_recover')).toBe(true);
    });

    // ─── 反向测试 3: init() 恢复旧版 .tmp_<uuid>_<original>.md stage ────────
    it('init() recovers old-format .tmp_<uuid>_<original>.md stage file', async () => {
      const originalName = '1700000000000_message_1_abcd1234.md';
      const oldStageName = `.tmp_abc12345_${originalName}`;  // 旧格式：以 .md 结尾
      const stageContent = '---\nid: msg-old-stage\n---\nold stage body\n';
      await fs.writeFile(path.join(pendingDir(), oldStageName), stageContent);

      const calls: Array<{ type: string; cols: string[] }> = [];
      const audit = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push({ type, cols: cols.map(String) });
        },
      };
      const freshReader = new InboxReader(
        pendingDir(),
        path.join(testDir, 'inbox', 'done'),
        path.join(testDir, 'inbox', 'failed'),
        nfs,
        audit,
      );
      await freshReader.init();

      // target 已恢复、旧 stage 已删除
      expect(await fs.readFile(path.join(pendingDir(), originalName), 'utf-8')).toBe(stageContent);
      const remaining = await fs.readdir(pendingDir());
      expect(remaining).not.toContain(oldStageName);
      // audit: INBOX_RECONCILE from=stage
      const reconcile = calls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RECONCILE);
      expect(reconcile).toHaveLength(1);
      expect(reconcile[0].cols.some(c => c === 'from=stage')).toBe(true);
    });

    // ─── 反向测试 4: init() 同内容 dedupe 旧版 stage ─────────────────────────
    it('init() dedupes old-format stage when target exists with same content', async () => {
      const originalName = '1700000000000_msg_dup_test.md';
      const oldStageName = `.tmp_abc12345_${originalName}`;
      const content = '---\nid: dup-msg\n---\ndup body\n';
      // 先写 target
      await fs.writeFile(path.join(pendingDir(), originalName), content);
      // 再写旧格式 stage（同内容）
      await fs.writeFile(path.join(pendingDir(), oldStageName), content);

      const calls: Array<{ type: string; cols: string[] }> = [];
      const audit = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push({ type, cols: cols.map(String) });
        },
      };
      const freshReader = new InboxReader(
        pendingDir(),
        path.join(testDir, 'inbox', 'done'),
        path.join(testDir, 'inbox', 'failed'),
        nfs,
        audit,
      );
      await freshReader.init();

      // target 保留、stage 删除
      expect(await fs.readFile(path.join(pendingDir(), originalName), 'utf-8')).toBe(content);
      const remaining = await fs.readdir(pendingDir());
      expect(remaining).not.toContain(oldStageName);
      // audit: INBOX_DEDUPED
      expect(calls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED)).toBe(true);
      // failed/ 无新增
      const failedFiles = await fs.readdir(path.join(testDir, 'inbox', 'failed'));
      expect(failedFiles.filter(f => f.endsWith('.md'))).toHaveLength(0);
    });

    // ─── 反向测试 5: init() 异内容 DLQ 旧版 stage ────────────────────────────
    it('init() DLQs old-format stage when target exists with different content', async () => {
      const originalName = '1700000000000_msg_conflict_test.md';
      const oldStageName = `.tmp_abc12345_${originalName}`;
      const targetContent = '---\nid: conflict-msg\n---\ntarget body\n';
      const stageContent = '---\nid: conflict-msg\n---\nstage body (diverged)\n';
      await fs.writeFile(path.join(pendingDir(), originalName), targetContent);
      await fs.writeFile(path.join(pendingDir(), oldStageName), stageContent);

      const calls: Array<{ type: string; cols: string[] }> = [];
      const audit = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push({ type, cols: cols.map(String) });
        },
      };
      const freshReader = new InboxReader(
        pendingDir(),
        path.join(testDir, 'inbox', 'done'),
        path.join(testDir, 'inbox', 'failed'),
        nfs,
        audit,
      );
      await freshReader.init();

      // target 保留原内容
      expect(await fs.readFile(path.join(pendingDir(), originalName), 'utf-8')).toBe(targetContent);
      // stage 已删除
      const remaining = await fs.readdir(pendingDir());
      expect(remaining).not.toContain(oldStageName);
      // stage 内容入 failed/DLQ
      const failedFiles = await fs.readdir(path.join(testDir, 'inbox', 'failed'));
      const dlqFiles = failedFiles.filter(f => f.endsWith('.md'));
      expect(dlqFiles).toHaveLength(1);
      expect(await fs.readFile(path.join(testDir, 'inbox', 'failed', dlqFiles[0]), 'utf-8')).toBe(stageContent);
      // audit: INBOX_RESTORE_CONFLICT
      const conflict = calls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RESTORE_CONFLICT);
      expect(conflict).toHaveLength(1);
      expect(conflict[0].cols.some(c => c === 'op=recover_stage')).toBe(true);
    });

    // ─── 反向测试 6: init() 无法解析的旧版 stage 入 quarantine ───────────────
    it('init() quarantines unparseable old-format .tmp_ file', async () => {
      // 格式不符合 OLD_STAGE_RE（uuid 段不是 8 位 hex）
      const weirdName = '.tmp_badformat_no_separator.md';
      const content = '---\nid: weird\n---\nweird body\n';
      await fs.writeFile(path.join(pendingDir(), weirdName), content);

      const calls: Array<{ type: string; cols: string[] }> = [];
      const audit = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push({ type, cols: cols.map(String) });
        },
      };
      const freshReader = new InboxReader(
        pendingDir(),
        path.join(testDir, 'inbox', 'done'),
        path.join(testDir, 'inbox', 'failed'),
        nfs,
        audit,
      );
      await freshReader.init();

      // pending 中旧文件已移除
      const remaining = await fs.readdir(pendingDir());
      expect(remaining).not.toContain(weirdName);
      // 内容移入 failed/（quarantine）
      const failedFiles = await fs.readdir(path.join(testDir, 'inbox', 'failed'));
      const quarantineFiles = failedFiles.filter(f => f.includes('quarantine'));
      expect(quarantineFiles).toHaveLength(1);
      // audit: INBOX_STAGE_QUARANTINE
      const quarantineAudit = calls.filter(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_STAGE_QUARANTINE);
      expect(quarantineAudit).toHaveLength(1);
      expect(quarantineAudit[0].cols.some(c => c.includes('unparseable_old_stage_format'))).toBe(true);
    });

    // ─── 反向测试: EEXIST 竞态恢复（并发写入出现 target）─────────────────
    it('init() handles EEXIST race during stage recovery — concurrent target appears', async () => {
      const originalName = '1700000000000_msg_race_target.md';
      const stageName = `.tmp_abc12345_${originalName}.staging`;
      const stageContent = '---\nid: race-stage\n---\nstage content\n';
      const racedContent = '---\nid: race-target\n---\nraced content (different)\n';
      await fs.writeFile(path.join(pendingDir(), stageName), stageContent);

      // 模拟并发：先写一个 target，使 writeExclusiveSync 触发 EEXIST
      // 但测试无法直接注入 EEXIST。改为验证：target 存在时正常走三向决策
      // （EEXIST 路径的最终行为与 target-already-exists 一致）
      await fs.writeFile(path.join(pendingDir(), originalName), racedContent);

      const calls: Array<{ type: string; cols: string[] }> = [];
      const audit = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push({ type, cols: cols.map(String) });
        },
      };
      const freshReader = new InboxReader(
        pendingDir(),
        path.join(testDir, 'inbox', 'done'),
        path.join(testDir, 'inbox', 'failed'),
        nfs,
        audit,
      );
      await freshReader.init();

      // target 保留原内容（未覆盖）
      expect(await fs.readFile(path.join(pendingDir(), originalName), 'utf-8')).toBe(racedContent);
      // stage 入 failed/DLQ（异内容）
      const failedFiles = await fs.readdir(path.join(testDir, 'inbox', 'failed'));
      const dlqFiles = failedFiles.filter(f => f.endsWith('.md'));
      expect(dlqFiles).toHaveLength(1);
      expect(await fs.readFile(path.join(path.join(testDir, 'inbox', 'failed'), dlqFiles[0]), 'utf-8')).toBe(stageContent);
      // audit: INBOX_RESTORE_CONFLICT
      expect(calls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_RESTORE_CONFLICT)).toBe(true);
    });

    // ─── 反向测试: EEXIST 竞态恢复（并发写入同内容 → dedupe）────────────
    it('init() handles EEXIST race — concurrent target with same content → dedupe', async () => {
      const originalName = '1700000000000_msg_race_same.md';
      const stageName = `.tmp_abc12345_${originalName}.staging`;
      const content = '---\nid: race-same\n---\nsame content\n';
      await fs.writeFile(path.join(pendingDir(), stageName), content);
      // target 存在且同内容（模拟 EEXIST 后重读发现的场景）
      await fs.writeFile(path.join(pendingDir(), originalName), content);

      const calls: Array<{ type: string; cols: string[] }> = [];
      const audit = {
        write(type: string, ...cols: (string | number)[]) {
          calls.push({ type, cols: cols.map(String) });
        },
      };
      const freshReader = new InboxReader(
        pendingDir(),
        path.join(testDir, 'inbox', 'done'),
        path.join(testDir, 'inbox', 'failed'),
        nfs,
        audit,
      );
      await freshReader.init();

      // target 保留
      expect(await fs.readFile(path.join(pendingDir(), originalName), 'utf-8')).toBe(content);
      // stage 已删除
      expect(await fs.readdir(pendingDir())).not.toContain(stageName);
      // audit: INBOX_DEDUPED（同内容）
      expect(calls.some(c => c.type === MESSAGING_AUDIT_EVENTS.INBOX_DEDUPED)).toBe(true);
      // failed/ 无新增
      const failedFiles = await fs.readdir(path.join(testDir, 'inbox', 'failed'));
      expect(failedFiles.filter(f => f.endsWith('.md'))).toHaveLength(0);
    });
  });
});
