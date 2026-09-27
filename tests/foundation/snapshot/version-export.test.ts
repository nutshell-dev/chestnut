/**
 * phase 1918 Step D：固定版本导出（version-store exportVersion）契约测试。
 *
 * 真实 Git 验证：
 * - 导出固定版本完整内容（二进制、模式位、目录结构）；后续发布不改变已固定导出
 * - symlink 安全策略：根内相对链接物化；逃逸/绝对链接明确拒绝（symlink_escape）
 * - 缺失/损坏对象不能用 live 内容冒充旧版本（loud git_error）
 * - 读固定 commit 不 checkout 共享根、不写全局 index、不动 published ref
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { createVersionStore } from '../../../src/foundation/snapshot/index.js';
import type { VersionId, VersionStore } from '../../../src/foundation/snapshot/index.js';
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

describe.skipIf(!gitAvailable)('version-store 固定版本导出（phase 1918 Step D）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('version-store-x-');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  const repositoryDir = () => path.join(tmpDir, 'repo');
  const workspaceParent = () => path.join(tmpDir, 'ws-parent');

  async function makeStore(): Promise<VersionStore> {
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    const fs = new NodeFileSystem({ baseDir: repositoryDir() });
    const { audit } = makeAudit();
    return createVersionStore({ repositoryDir: repositoryDir(), workspaceParent: workspaceParent(), fs, audit });
  }

  async function beginEditRaw(
    store: VersionStore,
    base: VersionId,
    opTag: string,
    write: (wsPath: string) => void,
  ): Promise<VersionId> {
    const ws = await store.begin({ operationId: `${opTag}-begin`, base });
    write(ws.path);
    return store.save({ workspaceId: ws.id, operationId: `${opTag}-save`, message: `edit ${opTag}` });
  }

  async function publishFiles(
    store: VersionStore,
    opTag: string,
    prefix: string,
    files: Record<string, string>,
    expected: VersionId | null,
  ): Promise<VersionId> {
    const candidate = await beginEditRaw(store, await store.readPublished(), opTag, (wsPath) => {
      for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(wsPath, rel);
        fsSync.mkdirSync(path.dirname(abs), { recursive: true });
        fsSync.writeFileSync(abs, content);
      }
    });
    const r = await store.publish({ operationId: `${opTag}-pub`, candidate, prefix, expectedPathRevision: expected, metadata: 'm' });
    expect(r.kind).toBe('published');
    return store.readPublished();
  }

  it('反向：并发发布不能改变已固定导出——导出 v1 在 v2 发布后仍是 v1 内容', async () => {
    const store = await makeStore();
    const v1 = await publishFiles(store, 'x1', 'skills/a', { 'skills/a/SKILL.md': 'v1\n' }, null);
    const rev1 = (await store.pathRevision(v1, 'skills/a')) as VersionId;
    const v2 = await publishFiles(store, 'x2', 'skills/a', { 'skills/a/SKILL.md': 'v2\n' }, rev1);
    expect(v2).not.toBe(v1);

    const dest = path.join(tmpDir, 'export-v1');
    await store.exportVersion(v1, 'skills/a', dest);
    expect(fsSync.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('v1\n');

    const dest2 = path.join(tmpDir, 'export-v2');
    await store.exportVersion(v2, 'skills/a', dest2);
    expect(fsSync.readFileSync(path.join(dest2, 'SKILL.md'), 'utf8')).toBe('v2\n');
  });

  it('导出二进制、模式位和目录结构', async () => {
    const store = await makeStore();
    const binary = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
    const version = await (async () => {
      const candidate = await beginEditRaw(store, await store.readPublished(), 'bin', (wsPath) => {
        const dir = path.join(wsPath, 'skills', 'a', 'nested', 'deep');
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(path.join(dir, 'data.bin'), binary);
        const script = path.join(wsPath, 'skills', 'a', 'run.sh');
        fsSync.writeFileSync(script, '#!/bin/sh\necho hi\n');
        fsSync.chmodSync(script, 0o755);
      });
      const r = await store.publish({ operationId: 'bin-pub', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
      expect(r.kind).toBe('published');
      return store.readPublished();
    })();

    const dest = path.join(tmpDir, 'export-bin');
    await store.exportVersion(version, 'skills/a', dest);
    expect(fsSync.readFileSync(path.join(dest, 'nested', 'deep', 'data.bin'))).toEqual(binary);
    const stat = fsSync.statSync(path.join(dest, 'run.sh'));
    expect(stat.mode & 0o111).not.toBe(0);
    expect(fsSync.readFileSync(path.join(dest, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n');
  });

  it('symlink 策略：根内相对链接物化；逃逸链接与绝对链接明确拒绝', async () => {
    const store = await makeStore();
    const candidate = await beginEditRaw(store, await store.readPublished(), 'ln', (wsPath) => {
      fsSync.mkdirSync(path.join(wsPath, 'skills', 'good'), { recursive: true });
      fsSync.writeFileSync(path.join(wsPath, 'skills', 'good', 'target.md'), 't\n');
      fsSync.symlinkSync('target.md', path.join(wsPath, 'skills', 'good', 'link.md'));
      fsSync.mkdirSync(path.join(wsPath, 'skills', 'evil'), { recursive: true });
      fsSync.writeFileSync(path.join(wsPath, 'skills', 'evil', 'x.md'), 'x\n');
      fsSync.symlinkSync('../../outside', path.join(wsPath, 'skills', 'evil', 'esc.md'));
      fsSync.mkdirSync(path.join(wsPath, 'skills', 'abs'), { recursive: true });
      fsSync.writeFileSync(path.join(wsPath, 'skills', 'abs', 'y.md'), 'y\n');
      fsSync.symlinkSync('/etc/passwd', path.join(wsPath, 'skills', 'abs', 'abs.md'));
    });
    const r = await store.publish({ operationId: 'ln-pub', candidate, prefix: 'skills', expectedPathRevision: null, metadata: 'm' });
    expect(r.kind).toBe('published');
    const version = await store.readPublished();

    // 根内相对链接：按原样物化
    const destGood = path.join(tmpDir, 'export-good');
    await store.exportVersion(version, 'skills/good', destGood);
    expect(fsSync.readlinkSync(path.join(destGood, 'link.md'))).toBe('target.md');
    expect(fsSync.readFileSync(path.join(destGood, 'link.md'), 'utf8')).toBe('t\n');

    // 逃逸链接：明确拒绝，不默默当普通文本
    await expect(store.exportVersion(version, 'skills/evil', path.join(tmpDir, 'export-evil')))
      .rejects.toMatchObject({ kind: 'symlink_escape' });
    // 绝对链接：明确拒绝
    await expect(store.exportVersion(version, 'skills/abs', path.join(tmpDir, 'export-abs')))
      .rejects.toMatchObject({ kind: 'symlink_escape' });
  });

  it('prefix 在该版本不存在 → not_found；destination 校验（相对路径 / .git 内）', async () => {
    const store = await makeStore();
    const version = await publishFiles(store, 'nf', 'skills/a', { 'skills/a/SKILL.md': 'v1\n' }, null);

    await expect(store.exportVersion(version, 'skills/never', path.join(tmpDir, 'export-never')))
      .rejects.toMatchObject({ kind: 'not_found' });
    await expect(store.exportVersion(version, 'skills/a', 'relative/dest'))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    await expect(store.exportVersion(version, 'skills/a', path.join(repositoryDir(), '.git', 'evil')))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
  });

  it('反向：缺失/损坏对象不能用 live 内容冒充旧版本——export loud 失败且 dest 无内容', async () => {
    const store = await makeStore();
    const v1 = await publishFiles(store, 'corrupt', 'skills/a', { 'skills/a/SKILL.md': 'old-bytes\n' }, null);
    // 改 live 内容（发布 v2），再破坏 v1 的 blob 对象
    const rev1 = (await store.pathRevision(v1, 'skills/a')) as VersionId;
    await publishFiles(store, 'corrupt2', 'skills/a', { 'skills/a/SKILL.md': 'live-bytes\n' }, rev1);
    const blob = git(repositoryDir(), 'rev-parse', `${v1}:skills/a/SKILL.md`);
    const objPath = path.join(repositoryDir(), '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    fsSync.rmSync(objPath);

    const dest = path.join(tmpDir, 'export-corrupt');
    await expect(store.exportVersion(v1, 'skills/a', dest)).rejects.toMatchObject({ kind: 'git_error' });
    // 不用 live 内容冒充：dest 无 SKILL.md
    expect(fsSync.existsSync(path.join(dest, 'SKILL.md'))).toBe(false);
  });

  it('导出不 checkout 共享根、不写全局 index、不动 published ref 与 HEAD', async () => {
    const store = await makeStore();
    const version = await publishFiles(store, 'iso', 'skills/a', { 'skills/a/SKILL.md': 'v1\n' }, null);
    const headBefore = git(repositoryDir(), 'symbolic-ref', 'HEAD');

    await store.exportVersion(version, 'skills/a', path.join(tmpDir, 'export-iso'));

    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(version);
    expect(git(repositoryDir(), 'symbolic-ref', 'HEAD')).toBe(headBefore);
    // 全局 index（共享根 .git/index）从未被本模块创建/写入
    expect(fsSync.existsSync(path.join(repositoryDir(), '.git', 'index'))).toBe(false);
    // 共享根工作树不被检出
    expect(fsSync.existsSync(path.join(repositoryDir(), 'skills'))).toBe(false);
  });
});
