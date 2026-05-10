import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import {
  createStreamWriter, StreamWriter,
} from '../../src/foundation/stream/index.js';
import {
  createSnapshot, Snapshot,
} from '../../src/foundation/snapshot/index.js';
import {
  createDialogStore, DialogStore,
} from '../../src/foundation/dialog-store/index.js';
import {
  createInboxReader, createOutboxWriter,
  InboxReader, OutboxWriter,
} from '../../src/foundation/messaging/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AuditWriter } from '../../src/foundation/audit/writer.js';

let tmpDirs: string[] = [];

function mkEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), 'factories-'));
  tmpDirs.push(dir);
  const fs = new NodeFileSystem({ baseDir: dir });
  const audit = new AuditWriter(fs, 'audit.tsv', null);
  return { dir, fs, audit };
}

describe('L2 factories — 行为契约', () => {
  afterEach(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true });
    }
    tmpDirs = [];
  });
  it('所有工厂：不缓存（两次调用返回不同实例）', () => {
    const { dir, fs, audit } = mkEnv();
    expect(createStreamWriter(fs, audit)).not.toBe(createStreamWriter(fs, audit));
    expect(createSnapshot(dir, fs, audit, [])).not.toBe(createSnapshot(dir, fs, audit, []));
    expect(createDialogStore(fs, 'dialog', audit, 'current.json', 'sp', 'c1')).not.toBe(createDialogStore(fs, 'dialog', audit, 'current.json', 'sp', 'c1'));
    expect(createInboxReader(fs, audit, 'inbox')).not.toBe(createInboxReader(fs, audit, 'inbox'));
    expect(createOutboxWriter('c1', dir, fs, audit)).not.toBe(createOutboxWriter('c1', dir, fs, audit));
  });

  it('createInboxReader：baseDir 透传，三子目录固定拼 pending/done/failed（结构断言）', async () => {
    const { dir, fs, audit } = mkEnv();
    const r = createInboxReader(fs, audit, 'my_inbox');
    await r.init();
    const sub = (await readdir(path.join(dir, 'my_inbox'))).sort();
    expect(sub).toEqual(['done', 'failed', 'pending']);
    // 反向保障：若工厂写错（拼成 'incoming' 或遗漏某子目录），子目录集合偏离
  });

  it('createInboxReader：行为往返（投 pending → drain → markDone 落 done）', async () => {
    // 结构断言只能抓"漏/多一个"，抓不出拼错分隔符（如 `${baseDir}pending` 漏斜杠）。
    // 此用例用真实往返验证工厂拼出的 pending/done 路径可被读写。
    const { dir, fs, audit } = mkEnv();
    const r = createInboxReader(fs, audit, 'tmp-inbox');
    await r.init();
    await fs.writeAtomic('tmp-inbox/pending/001_hello.md', '---\nfrom: test\n---\nhello');
    const entries = await r.drainInbox();
    expect(entries).toHaveLength(1);
    expect(entries[0].filePath).toContain('tmp-inbox/pending/001_hello.md');

    await r.markDone(entries[0].filePath);
    const doneFiles = await readdir(path.join(dir, 'tmp-inbox', 'done'));
    expect(doneFiles).toHaveLength(1);
    expect(doneFiles[0]).toContain('001_hello.md');
    // 若工厂体漏斜杠（`${baseDir}pending`），fs.write 会写到 `tmp-inboxpending/` 目录；
    // drainInbox 从拼对的 `tmp-inbox/pending` 读会返回空，断言失败。
  });

  it('createOutboxWriter：clawDir 透传（消息落在 <clawDir>/outbox/pending/）', async () => {
    const { dir, fs, audit } = mkEnv();
    const w = createOutboxWriter('c1', dir, fs, audit);
    const written = await w.write({ to: 'motion', type: 'question', content: 'hello world' });
    expect(written).toContain(path.join('outbox', 'pending'));
    const contents = await readFile(written, 'utf-8');
    expect(contents.length).toBeGreaterThan(0);
    // clawId 透传：消息 frontmatter 的 From 字段应等于工厂传入的 'c1'
    // 反向保障：若工厂体参数对调（new OutboxWriter(clawDir, clawId, fs, audit)），
    // TS 通过但 From 会变成 dir 绝对路径，此断言失败。
    expect(contents).toContain('**From:** c1');
  });

  it('createDialogStore：clawId 透传且无 UUID 默认兜底（签名要求显式传）', () => {
    const { fs, audit } = mkEnv();
    const sm = createDialogStore(fs, 'dialog', audit, 'current.json', 'sp', 'explicit-claw-id');
    expect(sm).toBeInstanceOf(DialogStore);
    // 编译期保障：省略 clawId 应 TS 报错——由 tsc 全量检查覆盖，不在此 it 断言
  });

  it('createDialogStore：dialogDir / clawId 透传（同类型 string 对调兜底）', async () => {
    // dialogDir 与 clawId 均为 string 相邻，TS 对调无法捕获——靠行为断言兜底。
    // 可观察锚点（src/foundation/dialog-store/store.ts）：
    //   - L33: currentPath = path.join(dialogDir, 'current.json')
    //   - L148: saved SessionData.clawId = this.clawId
    // 工厂若对调为 new DialogStore(fs, clawId, audit, dialogDir)：
    //   - current.json 会落在 'c1/current.json' 而非 'my_dialog/current.json' → readFile ENOENT
    //   - 或 saved.clawId 会变成 'my_dialog' 而非 'c1' → toBe 断言失败
    const { dir, fs, audit } = mkEnv();
    const sm = createDialogStore(fs, 'my_dialog', audit, 'current.json', 'sp', 'c1');
    await sm.save([{ role: 'user', content: 'hi' }]);
    const saved = JSON.parse(
      await readFile(path.join(dir, 'my_dialog', 'current.json'), 'utf-8'),
    );
    expect(saved.clawId).toBe('c1');
  });

  it('createStreamWriter / createSnapshot：返回类型正确（结构保底）', () => {
    const { dir, fs, audit } = mkEnv();
    expect(createStreamWriter(fs, audit)).toBeInstanceOf(StreamWriter);
    expect(createSnapshot(dir, fs, audit, [])).toBeInstanceOf(Snapshot);
  });
});
