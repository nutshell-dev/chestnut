/**
 * phase 1918 Step C：按路径条件发布（version-store publish）契约测试。
 *
 * 真实 Git 验证：
 * - 首发/常规发布：prepare 记录 → 私有 index 组合 → CAS 唯一提交点 → 完整结果记录
 * - 同 operationId 重放相同结果；输入漂移抛 invalid_argument
 * - 反向三项：同路径 loser 不覆盖 winner；不同路径 winner 不被整树覆盖；
 *   改后改回（ABA）仍按版本身份判冲突
 * - 屏障确定性并发：compose 后 CAS 交错，loser conflict 且候选可达（GC 后可读）
 * - busy：lock 竞争不归为语义冲突，记录保持 prepared，恢复后可续作成功
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { createVersionStore } from '../../../src/foundation/snapshot/index.js';
import type { PublishResult, VersionId, VersionStore } from '../../../src/foundation/snapshot/index.js';
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

type Exec = NonNullable<Parameters<typeof createVersionStore>[0]['exec']>;

interface Fixture {
  repositoryDir: string;
  workspaceParent: string;
  events: Array<[string, ...(string | number)[]]>;
  makeStore(exec?: Exec): Promise<VersionStore>;
  published(): string;
  pathRev(prefix: string): string | null;
  seed(prefix: string, files: Record<string, string>, opTag: string): Promise<{ published: string; pathRev: string }>;
  beginEdit(base: VersionId, opTag: string, files: Record<string, string>, exec?: Exec): Promise<{ workspaceId: string; candidate: VersionId }>;
}

describe.skipIf(!gitAvailable)('version-store 按路径条件发布（phase 1918 Step C）', () => {
  let tmpDir: string;
  let storeCounter = 0;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('version-store-c-');
    storeCounter = 0;
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  async function makeFixture(): Promise<Fixture> {
    const repositoryDir = path.join(tmpDir, 'repo');
    const workspaceParent = path.join(tmpDir, 'ws-parent');
    fsSync.mkdirSync(repositoryDir, { recursive: true });
    const { audit, events } = makeAudit();

    async function makeStore(exec?: Exec): Promise<VersionStore> {
      const fs = new NodeFileSystem({ baseDir: repositoryDir });
      return createVersionStore({ repositoryDir, workspaceParent, fs, audit, exec });
    }

    const fixture: Fixture = {
      repositoryDir,
      workspaceParent,
      events,
      makeStore,
      published: () => git(repositoryDir, 'rev-parse', 'refs/version/published'),
      pathRev: (prefix) => {
        const out = git(repositoryDir, 'rev-list', '--first-parent', '-n', '1', 'refs/version/published', '--', prefix);
        return out === '' ? null : out;
      },
      seed: async (prefix, files, opTag) => {
        const store = await makeStore();
        const base = fixture.published() as VersionId;
        const { candidate } = await fixture.beginEdit(base, opTag, files);
        const result = await store.publish({
          operationId: `${opTag}-publish`,
          candidate,
          prefix,
          expectedPathRevision: null,
          metadata: `seed ${opTag}`,
        });
        expect(result.kind).toBe('published');
        return { published: fixture.published(), pathRev: fixture.pathRev(prefix) as string };
      },
      beginEdit: async (base, opTag, files, exec) => {
        const s = await makeStore(exec);
        const ws = await s.begin({ operationId: `${opTag}-begin-${storeCounter++}`, base });
        for (const [rel, content] of Object.entries(files)) {
          const abs = path.join(ws.path, rel);
          fsSync.mkdirSync(path.dirname(abs), { recursive: true });
          fsSync.writeFileSync(abs, content);
        }
        const candidate = await s.save({ workspaceId: ws.id, operationId: `${opTag}-save`, message: `edit ${opTag}` });
        return { workspaceId: ws.id, candidate };
      },
    };
    // 初始化库
    await makeStore();
    return fixture;
  }

  it('首发发布成功：ref 原子推进、parent=旧 published、候选子树进入、operation-id 入提交信息', async () => {
    const f = await makeFixture();
    const store = await f.makeStore();
    const base = f.published();
    const { candidate } = await f.beginEdit(base as VersionId, 'first', { 'skills/a/SKILL.md': 'v1\n' });

    const result = await store.publish({
      operationId: 'pub-first', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm',
    });
    expect(result).toEqual({ kind: 'published', version: f.published() as VersionId });
    expect(result.kind === 'published' && result.version !== base).toBe(true);

    const head = f.published();
    expect(git(f.repositoryDir, 'rev-parse', `${head}^`)).toBe(base);
    expect(git(f.repositoryDir, 'show', `${head}:skills/a/SKILL.md`)).toBe('v1');
    expect(git(f.repositoryDir, 'log', '-1', '--format=%B', head)).toContain('operation-id: pub-first');
    expect(f.pathRev('skills/a')).toBe(head);
    expect(f.events.some(([t]) => t === 'snapshot_version_published')).toBe(true);
  });

  it('幂等重放：同 operationId 同输入返回相同结果且不推进 ref；输入漂移抛 invalid_argument', async () => {
    const f = await makeFixture();
    const store = await f.makeStore();
    const { pathRev } = await f.seed('skills/a', { 'skills/a/SKILL.md': 'v1\n' }, 'seed-a');
    const base = f.published();
    const { candidate } = await f.beginEdit(base as VersionId, 'replay', { 'skills/a/SKILL.md': 'v2\n' });

    const r1 = await store.publish({ operationId: 'pub-replay', candidate, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'm' });
    expect(r1.kind).toBe('published');
    const headAfterFirst = f.published();
    const r2 = await store.publish({ operationId: 'pub-replay', candidate, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'm' });
    expect(r2).toEqual(r1);
    expect(f.published()).toBe(headAfterFirst);

    const { candidate: other } = await f.beginEdit(base as VersionId, 'drift', { 'skills/a/SKILL.md': 'v3\n' });
    await expect(
      store.publish({ operationId: 'pub-replay', candidate: other, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'm' }),
    ).rejects.toMatchObject({ kind: 'invalid_argument' });
  });

  it('反向：同路径并发 loser 不覆盖 winner，冲突返回 current + retainedCandidate 且候选可达', async () => {
    const f = await makeFixture();
    const { pathRev } = await f.seed('skills/a', { 'skills/a/SKILL.md': 'v1\n' }, 'seed-a2');
    const base = f.published();
    const storeA = await f.makeStore();
    const storeB = await f.makeStore();
    const { candidate: candA } = await f.beginEdit(base as VersionId, 'raceA', { 'skills/a/SKILL.md': 'A\n' });
    const { candidate: candB } = await f.beginEdit(base as VersionId, 'raceB', { 'skills/a/SKILL.md': 'B\n' });

    const rA = await storeA.publish({ operationId: 'pub-raceA', candidate: candA, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'A' });
    expect(rA.kind).toBe('published');
    const rB = await storeB.publish({ operationId: 'pub-raceB', candidate: candB, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'B' });

    expect(rB).toEqual({ kind: 'conflict', current: f.published() as VersionId, retainedCandidate: candB });
    // loser 不覆盖 winner
    expect(git(f.repositoryDir, 'show', `${f.published()}:skills/a/SKILL.md`)).toBe('A');
    // 冲突候选以可达 ref 保留（不靠 reflog）：GC 后仍可读
    git(f.repositoryDir, 'gc', '--prune=now');
    expect(git(f.repositoryDir, 'show', `${candB}:skills/a/SKILL.md`)).toBe('B');
    expect(f.events.some(([t]) => t === 'snapshot_version_publish_conflict')).toBe(true);
  });

  it('屏障确定性并发：B 在 CAS 前被 A 抢先 → B conflict；同 operationId 重放同一冲突结果', async () => {
    const f = await makeFixture();
    const { pathRev } = await f.seed('skills/a', { 'skills/a/SKILL.md': 'v1\n' }, 'seed-bar');
    const base = f.published();
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;

    let bArrived!: () => void;
    const bArrivedPromise = new Promise<void>(resolve => { bArrived = resolve; });
    let releaseB!: () => void;
    const releaseBPromise = new Promise<void>(resolve => { releaseB = resolve; });
    const barrierExec = (async (file: string, args: string[], opts: unknown) => {
      const mIndex = args.indexOf('-m');
      if (args.includes('commit-tree') && mIndex >= 0 && String(args[mIndex + 1]).startsWith('publish ')) {
        bArrived();
        await releaseBPromise;
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;

    const storeA = await f.makeStore();
    const storeB = await f.makeStore(barrierExec);
    const { candidate: candA } = await f.beginEdit(base as VersionId, 'barA', { 'skills/a/SKILL.md': 'A\n' });
    const { candidate: candB } = await f.beginEdit(base as VersionId, 'barB', { 'skills/a/SKILL.md': 'B\n' });

    let resultB: PublishResult | undefined;
    const pB = storeB.publish({ operationId: 'pub-barB', candidate: candB, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'B' })
      .then(r => { resultB = r; });
    await bArrivedPromise; // B 已组合完毕、悬在 CAS 前
    const rA = await storeA.publish({ operationId: 'pub-barA', candidate: candA, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'A' });
    expect(rA.kind).toBe('published');
    releaseB();
    await pB;

    expect(resultB).toEqual({ kind: 'conflict', current: f.published() as VersionId, retainedCandidate: candB });
    expect(git(f.repositoryDir, 'show', `${f.published()}:skills/a/SKILL.md`)).toBe('A');
    // 同 operationId 重放同一冲突结果
    const replay = await storeB.publish({ operationId: 'pub-barB', candidate: candB, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'B' });
    expect(replay).toEqual(resultB);
  });

  it('反向：不同路径 winner 不被整树覆盖——双方均发布，另一方子树原样保留', async () => {
    const f = await makeFixture();
    await f.seed('skills/a', { 'skills/a/SKILL.md': 'a0\n' }, 'seed-da');
    const { pathRev: revB0 } = await f.seed('skills/b', { 'skills/b/SKILL.md': 'b0\n' }, 'seed-db');
    const revA0 = f.pathRev('skills/a') as string;
    const base = f.published();

    const storeA = await f.makeStore();
    const storeB = await f.makeStore();
    const { candidate: candA } = await f.beginEdit(base as VersionId, 'dpA', { 'skills/a/SKILL.md': 'a1\n' });
    const { candidate: candB } = await f.beginEdit(base as VersionId, 'dpB', { 'skills/b/SKILL.md': 'b1\n' });

    const rA = await storeA.publish({ operationId: 'pub-dpA', candidate: candA, prefix: 'skills/a', expectedPathRevision: revA0 as VersionId, metadata: 'A' });
    expect(rA.kind).toBe('published');
    // B 的路径基准未变（A 只动了 skills/a）→ 系统重试组合最新 tree 后发布
    const rB = await storeB.publish({ operationId: 'pub-dpB', candidate: candB, prefix: 'skills/b', expectedPathRevision: revB0 as VersionId, metadata: 'B' });
    expect(rB.kind).toBe('published');

    const head = f.published();
    expect(git(f.repositoryDir, 'show', `${head}:skills/a/SKILL.md`)).toBe('a1');
    expect(git(f.repositoryDir, 'show', `${head}:skills/b/SKILL.md`)).toBe('b1');
    // B 的发布提交 parent = A 的 published（线性历史，不是覆盖整树）
    expect(git(f.repositoryDir, 'rev-parse', `${head}^`)).toBe(rA.kind === 'published' ? rA.version : '');
  });

  it('反向：改后改回（ABA）仍冲突——按版本身份而非 tree hash 判路径基准', async () => {
    const f = await makeFixture();
    const { pathRev: rev1 } = await f.seed('skills/a', { 'skills/a/SKILL.md': 'X\n' }, 'aba-1');
    const store = await f.makeStore();

    // v2: X → Y
    let base = f.published();
    let edit = await f.beginEdit(base as VersionId, 'aba-2', { 'skills/a/SKILL.md': 'Y\n' });
    let r = await store.publish({ operationId: 'pub-aba-2', candidate: edit.candidate, prefix: 'skills/a', expectedPathRevision: rev1 as VersionId, metadata: 'Y' });
    expect(r.kind).toBe('published');
    const rev2 = f.pathRev('skills/a') as string;

    // v3: Y → X（内容与 v1 相同，但版本身份必须不同）
    base = f.published();
    edit = await f.beginEdit(base as VersionId, 'aba-3', { 'skills/a/SKILL.md': 'X\n' });
    r = await store.publish({ operationId: 'pub-aba-3', candidate: edit.candidate, prefix: 'skills/a', expectedPathRevision: rev2 as VersionId, metadata: 'X2' });
    expect(r.kind).toBe('published');
    const rev3 = f.pathRev('skills/a') as string;
    expect(rev3).not.toBe(rev1);
    expect(git(f.repositoryDir, 'show', `${f.published()}:skills/a/SKILL.md`)).toBe('X');

    // 基于 rev1 观察的候选（即使内容与当前一致）必须冲突
    const stale = await f.beginEdit(base as VersionId, 'aba-stale', { 'skills/a/SKILL.md': 'X\n' });
    const conflict = await store.publish({ operationId: 'pub-aba-stale', candidate: stale.candidate, prefix: 'skills/a', expectedPathRevision: rev1 as VersionId, metadata: 'stale' });
    expect(conflict.kind).toBe('conflict');
  });

  it('候选改了 prefix 外路径 → 抛 candidate_out_of_scope，published 不动、候选保留', async () => {
    const f = await makeFixture();
    const { pathRev } = await f.seed('skills/a', { 'skills/a/SKILL.md': 'v1\n' }, 'seed-scope');
    const base = f.published();
    const store = await f.makeStore();
    const { candidate, workspaceId } = await f.beginEdit(base as VersionId, 'scope', {
      'skills/a/SKILL.md': 'v2\n',
      'skills/other/SKILL.md': 'escape\n',
    });

    await expect(
      store.publish({ operationId: 'pub-scope', candidate, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'm' }),
    ).rejects.toMatchObject({ kind: 'candidate_out_of_scope' });
    expect(git(f.repositoryDir, 'show', `${f.published()}:skills/a/SKILL.md`)).toBe('v1');
    expect(() => git(f.repositoryDir, 'show', `${f.published()}:skills/other/SKILL.md`)).toThrow();
    // 候选保留：分支 ref 可达
    expect(git(f.repositoryDir, 'rev-parse', `refs/version/workspaces/${workspaceId}`)).toBe(candidate);
  });

  it('busy：CAS lock 竞争不归为语义冲突；记录保持 prepared，恢复后同 operationId 续作成功', async () => {
    const f = await makeFixture();
    const { pathRev } = await f.seed('skills/a', { 'skills/a/SKILL.md': 'v1\n' }, 'seed-busy');
    const base = f.published();
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;

    let injectLock = true;
    const lockExec = (async (file: string, args: string[], opts: unknown) => {
      if (injectLock && args.includes('update-ref') && args.includes('refs/version/published')) {
        const e = new Error('fatal: cannot lock ref') as Error & { exitCode: number; output: string };
        e.exitCode = 128;
        e.output = "fatal: cannot lock ref 'refs/version/published': Unable to create lock File exists";
        throw e;
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;

    const storeBusy = await f.makeStore(lockExec);
    const { candidate } = await f.beginEdit(base as VersionId, 'busy', { 'skills/a/SKILL.md': 'v2\n' });
    const r = await storeBusy.publish({ operationId: 'pub-busy', candidate, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'm' });
    expect(r).toEqual({ kind: 'busy', operationId: 'pub-busy' });
    expect(f.events.some(([t]) => t === 'snapshot_version_publish_busy')).toBe(true);
    expect(f.events.some(([t]) => t === 'snapshot_version_publish_conflict')).toBe(false);
    // ref 未被伪造推进
    expect(f.published()).toBe(base);

    // 恢复：去掉注入后同 operationId 续作（prepared 记录 + 尝试 ref 保留）
    injectLock = false;
    const r2 = await storeBusy.publish({ operationId: 'pub-busy', candidate, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'm' });
    expect(r2.kind).toBe('published');
    expect(git(f.repositoryDir, 'show', `${f.published()}:skills/a/SKILL.md`)).toBe('v2');
    // 全部尝试 commit 均可达
    const attemptRefs = git(f.repositoryDir, 'for-each-ref', '--format=%(refname)', 'refs/version/attempts/');
    expect(attemptRefs).toContain('refs/version/attempts/publish-');
  });

  it('expectedPathRevision=null 但 prefix 已有发布历史 → conflict（首发语义不覆盖既有版本）', async () => {
    const f = await makeFixture();
    await f.seed('skills/a', { 'skills/a/SKILL.md': 'v1\n' }, 'seed-null');
    const base = f.published();
    const store = await f.makeStore();
    const { candidate } = await f.beginEdit(base as VersionId, 'nullcase', { 'skills/a/SKILL.md': 'v2\n' });
    const r = await store.publish({ operationId: 'pub-null', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm' });
    expect(r.kind).toBe('conflict');
  });

  it('metadata 只校验大小/编码：超长抛 invalid_argument，任意不透明内容原样接受', async () => {
    const f = await makeFixture();
    const { pathRev } = await f.seed('skills/a', { 'skills/a/SKILL.md': 'v1\n' }, 'seed-meta');
    const base = f.published();
    const store = await f.makeStore();
    const { candidate } = await f.beginEdit(base as VersionId, 'meta', { 'skills/a/SKILL.md': 'v2\n' });
    await expect(
      store.publish({ operationId: 'pub-meta-long', candidate, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: 'x'.repeat(16_001) }),
    ).rejects.toMatchObject({ kind: 'invalid_argument' });
    const opaque = '任意 opaque 内容\nwith\nnewlines 与 unicode ✓';
    const r = await store.publish({ operationId: 'pub-meta', candidate, prefix: 'skills/a', expectedPathRevision: pathRev as VersionId, metadata: opaque });
    expect(r.kind).toBe('published');
  });

  it('prefix 校验：越界/绝对/语法元字符一律 invalid_argument', async () => {
    const f = await makeFixture();
    const store = await f.makeStore();
    const base = f.published();
    const { candidate } = await f.beginEdit(base as VersionId, 'pbad', { 'skills/a/SKILL.md': 'v2\n' });
    for (const bad of ['', '/abs', '../escape', 'a/../b', 'a//b', 'a/', 'a\\b', 'a:b', 'a*b', 'a?b', 'a[b']) {
      await expect(
        store.publish({ operationId: `pub-pbad-${bad}`, candidate, prefix: bad, expectedPathRevision: null, metadata: 'm' }),
      ).rejects.toMatchObject({ kind: 'invalid_argument' });
    }
  });
});
