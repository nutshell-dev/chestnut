/**
 * phase 1918 Step B：通用分支工作区（version-store begin/save）契约测试。
 *
 * 真实 Git 验证：
 * - factory 创建/验证独立 Git 根（不向上发现 agent repo；失败保留现场不清理 .git）
 * - begin 幂等重开（重启不新建重复分支、保留未保存编辑）
 * - save 无节流完整捕获（-f 覆盖 ignore）、operationId 重试返回相同持久结果、
 *   空修改返回稳定提交身份
 * - 反向三项：两个工作区不共享 index；重启不新建重复分支；init/save 失败不删除
 *   已有库或返回成功
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { createVersionStore, VersionStoreError } from '../../../src/foundation/snapshot/index.js';
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

interface Fixture {
  store: VersionStore;
  repositoryDir: string;
  workspaceParent: string;
  events: Array<[string, ...(string | number)[]]>;
  published: string;
}

describe.skipIf(!gitAvailable)('version-store 分支工作区（phase 1918 Step B）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('version-store-b-');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  async function makeStore(opts?: { exec?: Parameters<typeof createVersionStore>[0]['exec']; fs?: FileSystem }): Promise<Fixture> {
    const repositoryDir = path.join(tmpDir, 'repo');
    const workspaceParent = path.join(tmpDir, 'ws-parent');
    fsSync.mkdirSync(repositoryDir, { recursive: true });
    const fs = opts?.fs ?? new NodeFileSystem({ baseDir: repositoryDir });
    const { audit, events } = makeAudit();
    const store = await createVersionStore({ repositoryDir, workspaceParent, fs, audit, exec: opts?.exec });
    const published = git(repositoryDir, 'rev-parse', 'refs/version/published');
    return { store, repositoryDir, workspaceParent, events, published };
  }

  it('factory 创建独立 Git 根：.git / published ref / HEAD symref / 归属标记 / 空初始提交', async () => {
    const { repositoryDir, published } = await makeStore();

    expect(git(repositoryDir, 'rev-parse', '--path-format=absolute', '--git-dir'))
      .toBe(fsSync.realpathSync(path.join(repositoryDir, '.git')));
    expect(git(repositoryDir, 'symbolic-ref', 'HEAD')).toBe('refs/version/published');
    expect(git(repositoryDir, 'config', 'chestnut.versionstore')).toBe('1918');
    expect(git(repositoryDir, 'cat-file', '-t', published)).toBe('commit');
    expect(git(repositoryDir, 'rev-list', '--count', published)).toBe('1');
    // 空初始提交：tree 为空
    expect(git(repositoryDir, 'ls-tree', published)).toBe('');
  });

  it('factory 幂等重开：同一 published，不重建库', async () => {
    const first = await makeStore();
    const fs2 = new NodeFileSystem({ baseDir: first.repositoryDir });
    const { audit } = makeAudit();
    const store2 = await createVersionStore({
      repositoryDir: first.repositoryDir,
      workspaceParent: first.workspaceParent,
      fs: fs2,
      audit,
    });
    expect(store2).toBeDefined();
    expect(git(first.repositoryDir, 'rev-parse', 'refs/version/published')).toBe(first.published);
  });

  it('factory 不向上发现 agent repo：父目录是 repo 时仍建独立嵌套根', async () => {
    // 把 tmpDir 本身变成 repo（模拟 agent repo），repositoryDir 在其内
    git(tmpDir, 'init');
    const repositoryDir = path.join(tmpDir, 'repo');
    fsSync.mkdirSync(repositoryDir, { recursive: true });
    const fs = new NodeFileSystem({ baseDir: repositoryDir });
    const { audit } = makeAudit();
    await createVersionStore({ repositoryDir, workspaceParent: path.join(tmpDir, 'ws'), fs, audit });

    expect(git(repositoryDir, 'rev-parse', '--path-format=absolute', '--show-toplevel'))
      .toBe(fsSync.realpathSync(repositoryDir));
    expect(git(repositoryDir, 'rev-parse', '--verify', 'refs/version/published')).toBeTruthy();
  });

  it('反向：init 失败（损坏 .git 现场）抛 repo_invalid 且绝不清理 .git', async () => {
    const repositoryDir = path.join(tmpDir, 'repo');
    fsSync.mkdirSync(path.join(repositoryDir, '.git'), { recursive: true });
    fsSync.writeFileSync(path.join(repositoryDir, '.git', ' garbage'), 'junk');
    const fs = new NodeFileSystem({ baseDir: repositoryDir });
    const { audit } = makeAudit();

    const err = await createVersionStore({
      repositoryDir,
      workspaceParent: path.join(tmpDir, 'ws'),
      fs,
      audit,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionStoreError);
    expect((err as VersionStoreError).kind).toBe('repo_invalid');
    // 现场保留：.git 未被清理
    expect(fsSync.existsSync(path.join(repositoryDir, '.git'))).toBe(true);
  });

  it('begin 创建分支工作区：内容检出、分支 ref、记录持久化、began 审计', async () => {
    const { store, repositoryDir, events, published } = await makeStore();
    const ws = await store.begin({ operationId: 'op-begin-1', base: published as VersionId });

    expect(ws.base).toBe(published);
    expect(ws.branch).toBe(`refs/version/workspaces/${ws.id}`);
    expect(fsSync.existsSync(path.join(ws.path, '.git'))).toBe(true);
    expect(git(repositoryDir, 'rev-parse', ws.branch)).toBe(published);
    // 工作区记录落盘
    const recRaw = fsSync.readFileSync(
      path.join(repositoryDir, '.git', 'version-store', 'workspaces', `${ws.id}.json`), 'utf8');
    expect(JSON.parse(recRaw)).toMatchObject({ kind: 'workspace', operationId: 'op-begin-1', base: published });
    expect(events.some(([t]) => t === 'snapshot_version_workspace_began')).toBe(true);
  });

  it('begin 幂等重开：同 operationId 返回同一工作区、未保存编辑原样保留、分支不推进', async () => {
    const { store, repositoryDir, published } = await makeStore();
    const ws1 = await store.begin({ operationId: 'op-reopen', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws1.path, 'draft.txt'), 'unsaved\n');

    const ws2 = await store.begin({ operationId: 'op-reopen', base: published as VersionId });
    expect(ws2.id).toBe(ws1.id);
    expect(ws2.path).toBe(ws1.path);
    expect(ws2.branch).toBe(ws1.branch);
    expect(git(repositoryDir, 'rev-parse', ws1.branch)).toBe(published);
    expect(fsSync.readFileSync(path.join(ws2.path, 'draft.txt'), 'utf8')).toBe('unsaved\n');
  });

  it('反向：重启（新 factory 实例）重开不新建重复分支', async () => {
    const first = await makeStore();
    const ws = await first.store.begin({ operationId: 'op-restart', base: first.published as VersionId });
    const before = git(first.repositoryDir, 'for-each-ref', 'refs/version/workspaces/');

    const fs2 = new NodeFileSystem({ baseDir: first.repositoryDir });
    const { audit } = makeAudit();
    const store2 = await createVersionStore({
      repositoryDir: first.repositoryDir,
      workspaceParent: first.workspaceParent,
      fs: fs2,
      audit,
    });
    const ws2 = await store2.begin({ operationId: 'op-restart', base: first.published as VersionId });

    expect(ws2.id).toBe(ws.id);
    expect(git(first.repositoryDir, 'for-each-ref', 'refs/version/workspaces/')).toBe(before);
  });

  it('save 完整捕获（含 ignore 内容）且无节流：两次相邻 save 都真实提交', async () => {
    const { store, repositoryDir, published } = await makeStore();
    const ws = await store.begin({ operationId: 'op-save', base: published as VersionId });
    fsSync.mkdirSync(path.join(ws.path, 'skills', 'a'), { recursive: true });
    fsSync.writeFileSync(path.join(ws.path, 'skills', 'a', 'SKILL.md'), 'v1\n');
    fsSync.writeFileSync(path.join(ws.path, '.gitignore'), 'scratch.tmp\n');
    fsSync.writeFileSync(path.join(ws.path, 'scratch.tmp'), 'ignored-by-content\n');

    const v1 = await store.save({ workspaceId: ws.id, operationId: 'save-1', message: 'first save' });
    expect(v1).not.toBe(published);
    // .gitignore 内容也被 -f 完整捕获，不静默缺字节
    expect(git(repositoryDir, 'show', `${v1}:scratch.tmp`)).toBe('ignored-by-content');
    expect(git(repositoryDir, 'show', `${v1}:skills/a/SKILL.md`)).toBe('v1');
    expect(git(repositoryDir, 'log', '-1', '--format=%B', v1)).toContain('first save');
    expect(git(repositoryDir, 'log', '-1', '--format=%B', v1)).toContain('operation-id: save-1');

    // 紧接第二次 save（30s 节流语义不存在）：真实产生新提交
    fsSync.writeFileSync(path.join(ws.path, 'skills', 'a', 'SKILL.md'), 'v2\n');
    const v2 = await store.save({ workspaceId: ws.id, operationId: 'save-2', message: 'second save' });
    expect(v2).not.toBe(v1);
    expect(git(repositoryDir, 'show', `${v2}:skills/a/SKILL.md`)).toBe('v2');
    expect(git(repositoryDir, 'rev-parse', `${v2}^`)).toBe(v1);
  });

  it('save 幂等：同 operationId 重试返回相同 version，分支尖不变；输入漂移抛 invalid_argument', async () => {
    const { store, repositoryDir, published } = await makeStore();
    const ws = await store.begin({ operationId: 'op-idem', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'a\n');
    const v1 = await store.save({ workspaceId: ws.id, operationId: 'save-idem', message: 'm' });

    const v2 = await store.save({ workspaceId: ws.id, operationId: 'save-idem', message: 'm' });
    expect(v2).toBe(v1);
    expect(git(repositoryDir, 'rev-parse', ws.branch)).toBe(v1);

    await expect(store.save({ workspaceId: ws.id, operationId: 'save-idem', message: 'different' }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
  });

  it('save 空修改返回稳定提交身份（当前分支尖），不制造新提交', async () => {
    const { store, repositoryDir, published } = await makeStore();
    const ws = await store.begin({ operationId: 'op-nochange', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'a\n');
    const v1 = await store.save({ workspaceId: ws.id, operationId: 'save-nc-1', message: 'm1' });

    const v2 = await store.save({ workspaceId: ws.id, operationId: 'save-nc-2', message: 'm2' });
    expect(v2).toBe(v1);
    expect(git(repositoryDir, 'rev-parse', ws.branch)).toBe(v1);
  });

  it('反向：两个工作区不共享 index——各自捕获各自内容', async () => {
    const { store, repositoryDir, published } = await makeStore();
    const wsA = await store.begin({ operationId: 'op-idx-a', base: published as VersionId });
    const wsB = await store.begin({ operationId: 'op-idx-b', base: published as VersionId });
    fsSync.writeFileSync(path.join(wsA.path, 'only-a.txt'), 'A\n');
    fsSync.writeFileSync(path.join(wsB.path, 'only-b.txt'), 'B\n');

    const tipA = await store.save({ workspaceId: wsA.id, operationId: 'save-a', message: 'A' });
    const tipB = await store.save({ workspaceId: wsB.id, operationId: 'save-b', message: 'B' });

    expect(git(repositoryDir, 'show', `${tipA}:only-a.txt`)).toBe('A');
    expect(() => git(repositoryDir, 'show', `${tipA}:only-b.txt`)).toThrow();
    expect(git(repositoryDir, 'show', `${tipB}:only-b.txt`)).toBe('B');
    expect(() => git(repositoryDir, 'show', `${tipB}:only-a.txt`)).toThrow();
    // 两个独立 admin index
    const adminDirs = fsSync.readdirSync(path.join(repositoryDir, '.git', 'worktrees'));
    expect(adminDirs.length).toBe(2);
  });

  it('反向：save 失败不删除已有库、不返回成功；恢复后可重试', async () => {
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;
    let failAdd = true;
    const injectExec = (async (file: string, args: string[], opts: unknown) => {
      if (failAdd && args.includes('add') && !args.includes('worktree')) {
        const e = new Error('fatal: injected add failure') as Error & { exitCode: number; output: string };
        e.exitCode = 128;
        e.output = 'fatal: injected add failure';
        throw e;
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;

    const { store, repositoryDir, published, events } = await makeStore({ exec: injectExec });
    const ws = await store.begin({ operationId: 'op-savefail', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'a\n');

    await expect(store.save({ workspaceId: ws.id, operationId: 'save-fail', message: 'm' }))
      .rejects.toMatchObject({ kind: 'git_error' });
    // 库完好、published 不动、无成功记录
    expect(git(repositoryDir, 'rev-parse', 'refs/version/published')).toBe(published);
    expect(git(repositoryDir, 'rev-parse', ws.branch)).toBe(published);
    expect(events.some(([t]) => t === 'snapshot_version_save_failed')).toBe(true);

    failAdd = false;
    const v = await store.save({ workspaceId: ws.id, operationId: 'save-fail', message: 'm' });
    expect(git(repositoryDir, 'rev-parse', ws.branch)).toBe(v);
  });

  it('save 回执丢失（CAS 后完成记录写失败）：重试返回首次版本，绝不重新捕获可变工作区（phase 1920）', async () => {
    const repositoryDir = path.join(tmpDir, 'repo');
    fsSync.mkdirSync(repositoryDir, { recursive: true });
    const baseFs = new NodeFileSystem({ baseDir: repositoryDir });
    let failCompleted = true;
    const flakyFs = Object.create(baseFs) as FileSystem;
    const origWrite = baseFs.writeAtomic.bind(baseFs);
    flakyFs.writeAtomic = (rel: string, content: string) => {
      if (failCompleted && rel.includes('saves') && content.includes('"status":"completed"')) {
        return Promise.reject(new Error('injected: crash after CAS before save receipt'));
      }
      return origWrite(rel, content);
    };
    const { store, repositoryDir: repo, published } = await makeStore({ fs: flakyFs });
    const ws = await store.begin({ operationId: 'op-rcpt', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'v1\n');

    await expect(store.save({ workspaceId: ws.id, operationId: 'save-rcpt', message: 'm' }))
      .rejects.toThrow('injected: crash after CAS before save receipt');

    // CAS 已真实发生：分支尖 = 首次提交；记录停在 prepared
    const firstTip = git(repo, 'rev-parse', ws.branch);
    expect(firstTip).not.toBe(published);
    const commitsBefore = git(repo, 'rev-list', '--count', ws.branch);

    // 工作区继续改写：重试不得重新捕获这些内容，只能返回首次保存版本
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'v2-after-crash\n');
    failCompleted = false;
    const healed = await store.save({ workspaceId: ws.id, operationId: 'save-rcpt', message: 'm' });
    expect(healed).toBe(firstTip);
    expect(git(repo, 'rev-parse', ws.branch)).toBe(firstTip);
    expect(git(repo, 'rev-list', '--count', ws.branch)).toBe(commitsBefore);
    expect(git(repo, 'show', `${healed}:a.txt`)).toBe('v1');
    // 再次重放稳定
    const again = await store.save({ workspaceId: ws.id, operationId: 'save-rcpt', message: 'm' });
    expect(again).toBe(firstTip);
    void repositoryDir;
  });

  it('save CAS 暂态失败：候选已持久，重试续作同一候选、版本身份不变、不纳入后续改写（phase 1920）', async () => {
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;
    let failCas = true;
    const injectExec = (async (file: string, args: string[], opts: unknown) => {
      // 只拦截工作区分支的推进 CAS（保留 begin 的 create-only 与 attempt ref 更新）
      if (
        failCas && args.includes('update-ref') &&
        args.some(a => a.startsWith('refs/version/workspaces/')) &&
        !args.includes('0000000000000000000000000000000000000000')
      ) {
        const e = new Error('fatal: cannot lock ref') as Error & { exitCode: number; output: string };
        e.exitCode = 128;
        e.output = 'fatal: cannot lock ref';
        throw e;
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;

    const { store, repositoryDir, published } = await makeStore({ exec: injectExec });
    const ws = await store.begin({ operationId: 'op-casflaky', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'v1\n');

    await expect(store.save({ workspaceId: ws.id, operationId: 'save-cas', message: 'm' }))
      .rejects.toMatchObject({ kind: 'git_error' });
    // 候选已持久：确定性 attempt ref 可达，分支尖未推进
    const attemptRefs = git(repositoryDir, 'for-each-ref', '--format=%(refname)', 'refs/version/attempts/')
      .split('\n').filter(Boolean);
    expect(attemptRefs.length).toBe(1);
    const candidate = git(repositoryDir, 'rev-parse', attemptRefs[0]);
    expect(git(repositoryDir, 'rev-parse', ws.branch)).toBe(published);

    failCas = false;
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'v2-late\n');
    const v = await store.save({ workspaceId: ws.id, operationId: 'save-cas', message: 'm' });
    expect(v).toBe(candidate);
    expect(git(repositoryDir, 'rev-parse', ws.branch)).toBe(candidate);
    expect(git(repositoryDir, 'show', `${v}:a.txt`)).toBe('v1');
  });

  it('save 候选记录补全前崩溃：重试经确定性 attempt ref 恢复同一候选（phase 1920）', async () => {
    const repositoryDir = path.join(tmpDir, 'repo');
    fsSync.mkdirSync(repositoryDir, { recursive: true });
    const baseFs = new NodeFileSystem({ baseDir: repositoryDir });
    let failCandidate = true;
    const flakyFs = Object.create(baseFs) as FileSystem;
    const origWrite = baseFs.writeAtomic.bind(baseFs);
    flakyFs.writeAtomic = (rel: string, content: string) => {
      if (failCandidate && rel.includes('saves') && content.includes('"candidate"')) {
        return Promise.reject(new Error('injected: crash after commit-tree before candidate receipt'));
      }
      return origWrite(rel, content);
    };
    const { store, repositoryDir: repo, published } = await makeStore({ fs: flakyFs });
    const ws = await store.begin({ operationId: 'op-candrec', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'v1\n');

    await expect(store.save({ workspaceId: ws.id, operationId: 'save-candrec', message: 'm' }))
      .rejects.toThrow('injected: crash after commit-tree before candidate receipt');
    // 候选仅存于确定性 attempt ref；分支尖未推进；记录停在 prepared（无 candidate）
    const attemptRefs = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/version/attempts/')
      .split('\n').filter(Boolean);
    expect(attemptRefs.length).toBe(1);
    const candidate = git(repo, 'rev-parse', attemptRefs[0]);
    expect(git(repo, 'rev-parse', ws.branch)).toBe(published);

    failCandidate = false;
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'v2-late\n');
    const v = await store.save({ workspaceId: ws.id, operationId: 'save-candrec', message: 'm' });
    expect(v).toBe(candidate);
    expect(git(repo, 'show', `${v}:a.txt`)).toBe('v1');
    void repositoryDir;
  });

  it('旧 schema（pre-1920，无 status 字段）save 记录兼容读取：重放返回同一版本（phase 1920）', async () => {
    const { store, repositoryDir, published } = await makeStore();
    const ws = await store.begin({ operationId: 'op-legacy', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'a.txt'), 'a\n');
    const v1 = await store.save({ workspaceId: ws.id, operationId: 'save-legacy', message: 'm' });

    // 重写为 pre-1920 记录形态（只有完成态字段，无 status/tree/baseTip/candidate）
    const dir = path.join(repositoryDir, '.git', 'version-store', 'saves', ws.id);
    const file = fsSync.readdirSync(dir)[0];
    const full = path.join(dir, file);
    const rec = JSON.parse(fsSync.readFileSync(full, 'utf8')) as Record<string, unknown>;
    fsSync.writeFileSync(full, JSON.stringify({
      schema: 1,
      kind: 'save',
      operationId: rec.operationId,
      workspaceId: rec.workspaceId,
      version: rec.version,
      messageSha256: rec.messageSha256,
      noChange: rec.noChange,
    }));

    const v2 = await store.save({ workspaceId: ws.id, operationId: 'save-legacy', message: 'm' });
    expect(v2).toBe(v1);
    await expect(store.save({ workspaceId: ws.id, operationId: 'save-legacy', message: 'drift' }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
  });

  it('begin 输入漂移：同 operationId 不同 base 明确拒绝，旧工作区/分支/记录原样保留（phase 1920）', async () => {
    const { store, repositoryDir, published } = await makeStore();
    const ws = await store.begin({ operationId: 'op-drift', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'draft.txt'), 'unsaved\n');
    // 制造另一个合法 commit 作为漂移 base
    const other = await store.save({ workspaceId: ws.id, operationId: 'save-drift', message: 'm' });
    expect(other).not.toBe(published);

    await expect(store.begin({ operationId: 'op-drift', base: other }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    // 同 base 重放仍幂等成功
    const ws2 = await store.begin({ operationId: 'op-drift', base: published as VersionId });
    expect(ws2.id).toBe(ws.id);
    expect(fsSync.readFileSync(path.join(ws2.path, 'draft.txt'), 'utf8')).toBe('unsaved\n');

    // 重启（新实例）后漂移仍拒绝，工作区记录与分支不变
    const fs2 = new NodeFileSystem({ baseDir: repositoryDir });
    const { audit } = makeAudit();
    const store2 = await createVersionStore({
      repositoryDir, workspaceParent: path.join(tmpDir, 'ws-parent'), fs: fs2, audit,
    });
    await expect(store2.begin({ operationId: 'op-drift', base: other }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    const ws3 = await store2.begin({ operationId: 'op-drift', base: published as VersionId });
    expect(ws3).toEqual(ws2);
    expect(git(repositoryDir, 'rev-parse', ws.branch)).toBe(other);
    const recRaw = JSON.parse(fsSync.readFileSync(
      path.join(repositoryDir, '.git', 'version-store', 'workspaces', `${ws.id}.json`), 'utf8')) as Record<string, unknown>;
    expect(recRaw.base).toBe(published);
  });

  it('save 未知工作区抛 unknown_workspace；非法 base 抛 invalid_argument/unknown_version', async () => {
    const { store } = await makeStore();
    await expect(store.save({ workspaceId: 'ws-nonexistent', operationId: 'x', message: 'm' }))
      .rejects.toMatchObject({ kind: 'unknown_workspace' });
    await expect(store.begin({ operationId: 'op-badbase', base: 'not-a-sha' as VersionId }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    await expect(
      store.begin({ operationId: 'op-badbase2', base: '1'.repeat(40) as VersionId }),
    ).rejects.toMatchObject({ kind: 'unknown_version' });
  });

  it('symlink 内容按符号链接捕获（120000），不当普通文本', async () => {
    const { store, repositoryDir, published } = await makeStore();
    const ws = await store.begin({ operationId: 'op-symlink', base: published as VersionId });
    fsSync.writeFileSync(path.join(ws.path, 'target.md'), 't\n');
    fsSync.symlinkSync('target.md', path.join(ws.path, 'link.md'));

    const v = await store.save({ workspaceId: ws.id, operationId: 'save-link', message: 'm' });
    const entry = git(repositoryDir, 'ls-tree', '-r', v, '--', 'link.md');
    expect(entry).toMatch(/^120000 blob /);
    expect(git(repositoryDir, 'cat-file', 'blob', `${v}:link.md`)).toBe('target.md');
  });
});
