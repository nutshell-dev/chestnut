/**
 * phase 1918 Step D：固定版本读取与恢复（version-store read/recovery）契约测试。
 *
 * 真实 Git 验证：
 * - readPublished/pathRevision/history 只消费持久事实（Git ref 权威，不借投影）
 * - 恢复 prepare→CAS→receipt：CAS 已成功但回执丢失 → 重启按 ref 历史识别已提交，
 *   不再次发布、不改版本身份；CAS 未发生 → 保持待重试可续作
 * - inspectOperation 只暴露持久事实；history 不将冲突候选混为已发布版本
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { createVersionStore } from '../../../src/foundation/snapshot/index.js';
import type { VersionId, VersionStore } from '../../../src/foundation/snapshot/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

describe.skipIf(!gitAvailable)('version-store 固定版本读取与恢复（phase 1918 Step D）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('version-store-d-');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  const repositoryDir = () => path.join(tmpDir, 'repo');
  const workspaceParent = () => path.join(tmpDir, 'ws-parent');

  async function makeStore(events?: { events: Array<[string, ...(string | number)[]]> }, fsOverride?: FileSystem): Promise<VersionStore> {
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    const fs = fsOverride ?? new NodeFileSystem({ baseDir: repositoryDir() });
    const { audit, events: ev } = makeAudit();
    if (events) events.events = ev;
    return createVersionStore({ repositoryDir: repositoryDir(), workspaceParent: workspaceParent(), fs, audit });
  }

  async function beginEdit(store: VersionStore, base: VersionId, opTag: string, files: Record<string, string>): Promise<VersionId> {
    const ws = await store.begin({ operationId: `${opTag}-begin`, base });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(ws.path, rel);
      fsSync.mkdirSync(path.dirname(abs), { recursive: true });
      fsSync.writeFileSync(abs, content);
    }
    return store.save({ workspaceId: ws.id, operationId: `${opTag}-save`, message: `edit ${opTag}` });
  }

  it('readPublished/pathRevision：初始为 init 提交，发布后推进；未发布 prefix 为 null', async () => {
    const store = await makeStore();
    const initial = await store.readPublished();
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(initial);
    expect(await store.pathRevision(initial, 'skills/a')).toBe(null);

    const candidate = await beginEdit(store, initial, 'rd', { 'skills/a/SKILL.md': 'v1\n' });
    const r = await store.publish({ operationId: 'pub-rd', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
    expect(r.kind).toBe('published');
    const published = await store.readPublished();
    expect(published).not.toBe(initial);
    expect(await store.pathRevision(published, 'skills/a')).toBe(published);
    expect(await store.pathRevision(published, 'skills/b')).toBe(null);
    // 非法 version / prefix
    await expect(store.pathRevision('1'.repeat(40) as VersionId, 'skills/a')).rejects.toMatchObject({ kind: 'unknown_version' });
    await expect(store.pathRevision(published, '../x')).rejects.toMatchObject({ kind: 'invalid_argument' });
  });

  it('history 新→旧含 operationId；冲突候选不混为已发布版本', async () => {
    const store = await makeStore();
    const v0 = await store.readPublished();
    const c1 = await beginEdit(store, v0, 'h1', { 'skills/a/SKILL.md': 'v1\n' });
    const r1 = await store.publish({ operationId: 'pub-h1', candidate: c1, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
    const rev1 = (await store.pathRevision(await store.readPublished(), 'skills/a')) as VersionId;
    const c2 = await beginEdit(store, await store.readPublished(), 'h2', { 'skills/a/SKILL.md': 'v2\n' });
    const r2 = await store.publish({ operationId: 'pub-h2', candidate: c2, prefix: 'skills/a', expectedPathRevision: rev1, metadata: 'm' });
    // 制造一个冲突候选（基于 rev1 的过期发布）
    const c3 = await beginEdit(store, await store.readPublished(), 'h3', { 'skills/a/SKILL.md': 'v3\n' });
    const conflict = await store.publish({ operationId: 'pub-h3', candidate: c3, prefix: 'skills/a', expectedPathRevision: rev1, metadata: 'm' });
    expect(conflict.kind).toBe('conflict');

    const hist = await store.history('skills/a');
    expect(hist.map(h => h.version)).toEqual([
      r2.kind === 'published' ? r2.version : '',
      r1.kind === 'published' ? r1.version : '',
    ]);
    expect(hist.map(h => h.operationId)).toEqual(['pub-h2', 'pub-h1']);
    // Phase 1923 Step B：commit 时间随历史条目返回（ISO 8601 可解析，新→旧单调不增）
    for (const h of hist) {
      expect(Number.isNaN(Date.parse(h.committedAt))).toBe(false);
    }
    expect(Date.parse(hist[0].committedAt)).toBeGreaterThanOrEqual(Date.parse(hist[1].committedAt));
    // 冲突候选不在已发布历史；其操作事实经 inspectOperation 独立查询
    expect(hist.some(h => h.operationId === 'pub-h3')).toBe(false);
    const insp = await store.inspectOperation('pub-h3');
    expect(insp.kind).toBe('publish');
    expect(insp.kind === 'publish' && insp.result?.kind).toBe('conflict');
    // 从未发布的 prefix 无历史
    expect(await store.history('skills/never')).toEqual([]);
  });

  it('CAS 后回执丢失：重启（新实例）按 ref 历史识别已提交，不重发、不改版本身份', async () => {
    const holder = { events: [] as Array<[string, ...(string | number)[]]> };
    // 第一实例：注入 fs 故障——completed 结果记录写入失败（模拟 CAS 成功后崩溃）
    const baseFs = new NodeFileSystem({ baseDir: (fsSync.mkdirSync(repositoryDir(), { recursive: true }), repositoryDir()) });
    let failCompleted = true;
    const flakyFs = Object.create(baseFs) as FileSystem;
    const origWrite = baseFs.writeAtomic.bind(baseFs);
    flakyFs.writeAtomic = (rel: string, content: string) => {
      if (failCompleted && rel.includes('publishes') && content.includes('"status":"completed"')) {
        return Promise.reject(new Error('injected: crash after CAS before receipt'));
      }
      return origWrite(rel, content);
    };
    const store1 = await makeStore(holder, flakyFs);
    const v0 = await store1.readPublished();
    const candidate = await beginEdit(store1, v0, 'rec', { 'skills/a/SKILL.md': 'v1\n' });

    await expect(
      store1.publish({ operationId: 'pub-rec', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' }),
    ).rejects.toThrow('injected: crash after CAS before receipt');

    // CAS 已真实发生：published 已推进，但记录停在 prepared
    const attemptCommit = git(repositoryDir(), 'rev-parse', 'refs/version/published');
    expect(attemptCommit).not.toBe(v0);
    const inspBefore = await store1.inspectOperation('pub-rec');
    expect(inspBefore.kind === 'publish' && inspBefore.status).toBe('prepared');

    // 重启：全新实例（无注入），同 operationId 重试 → 识别已提交，不再次发布
    failCompleted = false;
    const store2 = await makeStore(holder);
    const healed = await store2.publish({ operationId: 'pub-rec', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
    expect(healed).toEqual({ kind: 'published', version: attemptCommit as VersionId });
    // 版本身份不变、ref 未二次推进
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(attemptCommit);
    expect(holder.events.some(([t, ...cols]) => t === 'snapshot_version_published' && cols.includes('outcome=recovered'))).toBe(true);
    // 恢复后记录完成
    const inspAfter = await store2.inspectOperation('pub-rec');
    expect(inspAfter.kind === 'publish' && inspAfter.status).toBe('completed');
    expect(inspAfter.kind === 'publish' && inspAfter.result).toEqual({ kind: 'published', version: attemptCommit });
    // 再次重试：重放相同结果
    const replay = await store2.publish({ operationId: 'pub-rec', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
    expect(replay).toEqual(healed);
  });

  it('CAS 未发生（prepared 停滞）：新实例续作发布成功', async () => {
    const holder = { events: [] as Array<[string, ...(string | number)[]]> };
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;
    const lockExec = (async (file: string, args: string[], opts: unknown) => {
      if (args.includes('update-ref') && args.includes('refs/version/published')) {
        const e = new Error('fatal: cannot lock ref') as Error & { exitCode: number; output: string };
        e.exitCode = 128;
        e.output = "fatal: cannot lock ref 'refs/version/published': Unable to create lock File exists";
        throw e;
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;

    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    // 先用正常 exec 完成库 init（lock 注入也会命中 init 的 published create-only CAS）
    await makeStore();
    const fs = new NodeFileSystem({ baseDir: repositoryDir() });
    const { audit } = makeAudit();
    const store1 = await createVersionStore({ repositoryDir: repositoryDir(), workspaceParent: workspaceParent(), fs, audit, exec: lockExec });
    const v0 = await store1.readPublished();
    const candidate = await beginEdit(store1, v0, 'stale', { 'skills/a/SKILL.md': 'v1\n' });
    const busy = await store1.publish({ operationId: 'pub-stale', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
    expect(busy.kind).toBe('busy');
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(v0);
    const insp = await store1.inspectOperation('pub-stale');
    expect(insp.kind === 'publish' && insp.status).toBe('prepared');
    expect(insp.kind === 'publish' && insp.attempts.length).toBeGreaterThan(0);

    // 重启：全新实例（无注入）续作 → prepared 记录 + 尝试 ref 保留 → 发布成功
    const store2 = await makeStore(holder);
    const r = await store2.publish({ operationId: 'pub-stale', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
    expect(r.kind).toBe('published');
    expect(git(repositoryDir(), 'show', 'refs/version/published:skills/a/SKILL.md')).toBe('v1');
  });

  it('save 回执丢失后重启（新实例）：按持久事实恢复首次保存版本，不二次捕获（phase 1920）', async () => {
    const holder = { events: [] as Array<[string, ...(string | number)[]]> };
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    const baseFs = new NodeFileSystem({ baseDir: repositoryDir() });
    let failCompleted = true;
    const flakyFs = Object.create(baseFs) as FileSystem;
    const origWrite = baseFs.writeAtomic.bind(baseFs);
    flakyFs.writeAtomic = (rel: string, content: string) => {
      if (failCompleted && rel.includes('saves') && content.includes('"status":"completed"')) {
        return Promise.reject(new Error('injected: crash after CAS before save receipt'));
      }
      return origWrite(rel, content);
    };
    const store1 = await makeStore(holder, flakyFs);
    const v0 = await store1.readPublished();
    const ws = await store1.begin({ operationId: 'rec-save-begin', base: v0 });
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'v1\n');

    await expect(store1.save({ workspaceId: ws.id, operationId: 'rec-save', message: 'm' }))
      .rejects.toThrow('injected: crash after CAS before save receipt');
    // CAS 已真实发生：分支尖 = 首次提交
    const firstTip = git(repositoryDir(), 'rev-parse', ws.branch);
    expect(firstTip).not.toBe(v0);

    // 重启：全新实例（无注入）；工作区在崩溃后继续被改写
    failCompleted = false;
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'v2-after-crash\n');
    const store2 = await makeStore(holder);
    const healed = await store2.save({ workspaceId: ws.id, operationId: 'rec-save', message: 'm' });
    expect(healed).toBe(firstTip);
    // 不二次捕获：分支历史仍是 init + 首次提交两个提交
    expect(git(repositoryDir(), 'rev-list', '--count', ws.branch)).toBe('2');
    expect(git(repositoryDir(), 'show', `${healed}:a.txt`)).toBe('v1');
    // 重放稳定；消息漂移仍 typed 拒绝
    const replay = await store2.save({ workspaceId: ws.id, operationId: 'rec-save', message: 'm' });
    expect(replay).toBe(firstTip);
    await expect(store2.save({ workspaceId: ws.id, operationId: 'rec-save', message: 'drift' }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
  });

  it('metadata 原文恢复：发布后重启可读取；CAS 后回执丢失恢复同版本同依据；旧记录显式 null（phase 1920）', async () => {
    const holder = { events: [] as Array<[string, ...(string | number)[]]> };
    const metadata = 'basis: retro 依据原文\n多行 ✓';

    // 第一实例：CAS 后完成记录写失败（回执丢失）
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    const baseFs = new NodeFileSystem({ baseDir: repositoryDir() });
    let failCompleted = true;
    const flakyFs = Object.create(baseFs) as FileSystem;
    const origWrite = baseFs.writeAtomic.bind(baseFs);
    flakyFs.writeAtomic = (rel: string, content: string) => {
      if (failCompleted && rel.includes('publishes') && content.includes('"status":"completed"')) {
        return Promise.reject(new Error('injected: crash after CAS before receipt'));
      }
      return origWrite(rel, content);
    };
    const store1 = await makeStore(holder, flakyFs);
    const v0 = await store1.readPublished();
    const candidate = await beginEdit(store1, v0, 'meta-rec', { 'skills/a/SKILL.md': 'v1\n' });
    await expect(
      store1.publish({ operationId: 'pub-meta-rec', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata }),
    ).rejects.toThrow('injected: crash after CAS before receipt');
    const committed = git(repositoryDir(), 'rev-parse', 'refs/version/published');

    // 重启（新实例）：识别已提交，同一版本；metadata 原文仍在
    failCompleted = false;
    const store2 = await makeStore(holder);
    const healed = await store2.publish({ operationId: 'pub-meta-rec', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata });
    expect(healed).toEqual({ kind: 'published', version: committed as VersionId });
    const insp = await store2.inspectOperation('pub-meta-rec');
    expect(insp.kind).toBe('publish');
    expect(insp.kind === 'publish' && insp.metadata).toBe(metadata);

    // 旧记录（pre-1920，无 metadata 字段）：重放按 hash 兼容，inspect 显式 null 不伪造依据
    const dir = path.join(repositoryDir(), '.git', 'version-store', 'publishes');
    const name = fsSync.readdirSync(dir).filter(n => n.endsWith('.json'))
      .find(n => (JSON.parse(fsSync.readFileSync(path.join(dir, n), 'utf8')) as Record<string, unknown>).operationId === 'pub-meta-rec');
    expect(name).toBeDefined();
    const full = path.join(dir, name as string);
    const rec = JSON.parse(fsSync.readFileSync(full, 'utf8')) as Record<string, unknown>;
    delete rec.metadata;
    fsSync.writeFileSync(full, JSON.stringify(rec));
    const legacyInsp = await store2.inspectOperation('pub-meta-rec');
    expect(legacyInsp.kind === 'publish' && legacyInsp.metadata).toBe(null);
    const legacyReplay = await store2.publish({ operationId: 'pub-meta-rec', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata });
    expect(legacyReplay).toEqual(healed);
    // 记录原文与 hash 不自洽 → loud record_corrupt，不静默接受
    rec.metadata = 'tampered 原文';
    fsSync.writeFileSync(full, JSON.stringify(rec));
    await expect(store2.inspectOperation('pub-meta-rec')).rejects.toMatchObject({ kind: 'record_corrupt' });
  });

  it('inspectOperation：unknown / workspace / publish 各形态只暴露持久事实', async () => {
    const store = await makeStore();
    expect(await store.inspectOperation('op-nothing')).toEqual({ kind: 'unknown', operationId: 'op-nothing' });

    const v0 = await store.readPublished();
    const ws = await store.begin({ operationId: 'op-insp-ws', base: v0 });
    const wsInsp = await store.inspectOperation('op-insp-ws');
    expect(wsInsp).toEqual({
      kind: 'workspace',
      operationId: 'op-insp-ws',
      workspaceId: ws.id,
      path: ws.path,
      branch: ws.branch,
      base: v0,
    });

    const candidate = await store.save({ workspaceId: ws.id, operationId: 'op-insp-save', message: 'm' });
    void candidate;
    const pub = await store.publish({ operationId: 'op-insp-pub', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
    expect(pub.kind).toBe('published');
    const pubInsp = await store.inspectOperation('op-insp-pub');
    expect(pubInsp.kind).toBe('publish');
    expect(pubInsp.kind === 'publish' && pubInsp.status).toBe('completed');
    expect(pubInsp.kind === 'publish' && pubInsp.result).toEqual(pub);
  });
});
