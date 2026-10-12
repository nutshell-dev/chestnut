/**
 * Phase 1935 Step C — VersionStore Git 协议/诊断通道分离（真实 Git + 故障注入）
 *
 * 命题：gitExec 成功数据仅取纯 stdout；注入 exec 包装把 warning 混进
 * output/stderr 而保持 r.stdout 不变，全链（create→begin→save→publish→
 * history/listPrefixes→export）必须正常；真实失败（git log 非零 / spawn 失败）
 * 语义不变；诊断经 GIT_STDERR 观察、审计失败时 fallback 留证且不覆盖 Git 结果。
 *
 * 不用 mock 固定 SHA 冒充真实 ref 更新：所有发布都走真实 Git 提交。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fsSync from 'fs';
import * as path from 'path';
import { createVersionStore, VersionStoreError } from '../../../src/foundation/snapshot/index.js';
import type { VersionId, VersionStore } from '../../../src/foundation/snapshot/index.js';
import { exec as realExec, ProcessExecError } from '../../../src/foundation/process-exec/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
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

const WARNING = 'warning: confstr(_CS_DARWIN_USER_TEMP_DIR) failed\n';

/**
 * 成功结果污染注入：warning 混入 output（旧缺陷形态）与 stderr，
 * 但保持 r.stdout 纯协议不变。若实现回退为消费 output 立即变红。
 */
function warningExec(): Exec {
  return (async (cmd: string, args: string[], opts: unknown) => {
    const r = await realExec(cmd, args, opts as never);
    return { ...r, output: r.output + WARNING, stderr: (r.stderr ?? '') + WARNING };
  }) as Exec;
}

/** publish 记录相对 repositoryDir 的稳定路径（与 version-store STATE_DIR 布局一致）。 */
function publishRecordAbsPath(repositoryDir: string, operationId: string): string {
  const opHash = createHash('sha256').update(`publish:${operationId}`).digest('hex');
  return path.join(repositoryDir, '.git', 'version-store', 'publishes', `${opHash}.json`);
}

describe.skipIf(!gitAvailable)('version-store stdout/stderr 通道分离（phase 1935 Step C）', () => {
  let tmpDir: string;
  let counter = 0;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('version-store-1935-');
    counter = 0;
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  async function makeFixture(exec?: Exec) {
    const repositoryDir = path.join(tmpDir, 'repo');
    const workspaceParent = path.join(tmpDir, 'ws-parent');
    fsSync.mkdirSync(repositoryDir, { recursive: true });
    const { audit, events } = makeAudit();

    async function makeStore(e?: Exec): Promise<VersionStore> {
      const fs = new NodeFileSystem({ baseDir: repositoryDir });
      return createVersionStore({ repositoryDir, workspaceParent, fs, audit, ...(e !== undefined ? { exec: e } : {}) });
    }

    const fixture = {
      repositoryDir,
      audit,
      events,
      makeStore,
      published: () => git(repositoryDir, 'rev-parse', 'refs/version/published'),
      beginEdit: async (base: VersionId, opTag: string, files: Record<string, string>, e?: Exec) => {
        const s = await makeStore(e);
        const ws = await s.begin({ operationId: `${opTag}-begin-${counter++}`, base });
        for (const [rel, content] of Object.entries(files)) {
          const abs = path.join(ws.path, rel);
          fsSync.mkdirSync(path.dirname(abs), { recursive: true });
          fsSync.writeFileSync(abs, content);
        }
        const candidate = await s.save({ workspaceId: ws.id, operationId: `${opTag}-save`, message: `edit ${opTag}` });
        return { workspaceId: ws.id, candidate };
      },
    };
    await fixture.makeStore(exec); // 初始化库（注入 exec 时 init 链也经受警告）
    return fixture;
  }

  it('警告注入下全链正常：合法 SHA、git log 三元组、空查询、NUL 与 blob 尾换行、诊断留证', async () => {
    const f = await makeFixture(warningExec());

    // open/readPublished：合法 SHA（rev-parse 协议未被警告污染）
    const store = await f.makeStore(warningExec());
    const base = await store.readPublished();
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    expect(base).toBe(f.published());

    // begin→save→publish：含 NUL 与尾换行的 blob
    const blobContent = 'line1\n\x00binary-ish\ntrail\n';
    const { candidate } = await f.beginEdit(base, 'full', { 'skills/a/SKILL.md': blobContent }, warningExec());
    expect(candidate).toMatch(/^[0-9a-f]{40}$/);
    const pub = await store.publish({
      operationId: 'op-full', candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'm',
    });
    expect(pub.kind).toBe('published');

    // history：git log NUL 三元组解析未被污染（版本 + operationId + committedAt）
    const hist = await store.history('skills/a');
    expect(hist).toHaveLength(1);
    expect(hist[0].version).toBe(f.published());
    expect(hist[0].operationId).toBe('op-full');
    expect(hist[0].committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 空查询：从未发布的路径 → 空数组（不伪造、不报错）
    expect(await store.history('skills/never')).toEqual([]);

    // listPrefixes：ls-tree NUL 解析未被污染
    const prefixes = await store.listPrefixes(f.published() as VersionId);
    expect(prefixes).toContain('skills');

    // export：blob 字节等值（raw 不 trim、尾换行与 NUL 保留）
    const dest = path.join(tmpDir, 'export');
    await store.exportVersion(f.published() as VersionId, 'skills/a', dest);
    expect(fsSync.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe(blobContent);

    // 诊断不静默丢弃：至少一条 GIT_STDERR 事件且保留 warning 原文
    const stderrEvents = f.events.filter((e) => e[0] === SNAPSHOT_AUDIT_EVENTS.GIT_STDERR);
    expect(stderrEvents.length).toBeGreaterThan(0);
    expect(stderrEvents.some((e) => String(e[2]).includes(WARNING.trim()))).toBe(true);
  });

  it('已发布但 operation 未完成窗口（1934 F fixture）+ 警告 → 重放恢复 published、零 conflict', async () => {
    const f = await makeFixture(warningExec());
    const store = await f.makeStore(warningExec());
    const base = await store.readPublished();

    // seed 首发
    const seedEdit = await f.beginEdit(base, 'seed', { 'skills/a/SKILL.md': 'v1\n' }, warningExec());
    const seedPub = await store.publish({
      operationId: 'op-seed', candidate: seedEdit.candidate, prefix: 'skills/a', expectedPathRevision: null, metadata: 'seed',
    });
    expect(seedPub.kind).toBe('published');

    // twin：同 operationId 发布已完成于历史中
    const twinBase = f.published() as VersionId;
    const twinEdit = await f.beginEdit(twinBase, 'twin', { 'skills/a/SKILL.md': 'v2\n' }, warningExec());
    const twinInput = {
      operationId: 'op-twin', candidate: twinEdit.candidate, prefix: 'skills/a',
      expectedPathRevision: twinBase, metadata: 'twin',
    };
    const twinPub = await store.publish(twinInput);
    expect(twinPub.kind).toBe('published');
    const publishedV1 = f.published();

    // 降级本地记录为 prepared/无 attempts（模拟 twin 窗口）
    const recPath = publishRecordAbsPath(f.repositoryDir, 'op-twin');
    const completedRec = JSON.parse(fsSync.readFileSync(recPath, 'utf8'));
    expect(completedRec.status).toBe('completed');
    fsSync.writeFileSync(recPath, JSON.stringify({ ...completedRec, status: 'prepared', attempts: [], result: undefined }));

    // 警告注入下重放：恢复既有 published（twin 胜），不写 conflict
    const replayStore = await f.makeStore(warningExec());
    const recovered = await replayStore.publish(twinInput);
    expect(recovered).toEqual({ kind: 'published', version: publishedV1 });
    expect(f.events.filter((e) => e[0] === 'snapshot_version_publish_conflict')).toHaveLength(0);
    const recAfter = JSON.parse(fsSync.readFileSync(recPath, 'utf8'));
    expect(recAfter.status).toBe('completed');
    expect(recAfter.result.kind).toBe('published');
  });

  it('真正 git log 非零继续 git_error，不据 stderr 文案伪造 absent', async () => {
    const f = await makeFixture();
    const base = f.published() as VersionId;
    const edit = await f.beginEdit(base, 'logfail', { 'skills/b/SKILL.md': 'b1\n' });
    const logFailExec: Exec = (async (cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'git' && args.includes('log')) {
        throw new ProcessExecError({ message: 'git log failed', output: 'fatal: unable to read log', exitCode: 128, stderr: 'fatal: unable to read log' });
      }
      return realExec(cmd, args, opts as never);
    }) as Exec;

    const store = await f.makeStore(logFailExec);
    await expect(store.publish({
      operationId: 'op-logfail', candidate: edit.candidate, prefix: 'skills/b', expectedPathRevision: null, metadata: 'm',
    })).rejects.toSatisfy((e) => e instanceof VersionStoreError && e.kind === 'git_error');
  });

  it('spawn 失败仍抛原错，不包装为 git_error', async () => {
    const f = await makeFixture();
    const base = f.published() as VersionId;
    const edit = await f.beginEdit(base, 'spawn', { 'skills/c/SKILL.md': 'c1\n' });
    const spawnErr = new Error('spawn git ENOENT');
    const spawnFailExec: Exec = (async (cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'git' && args.includes('log')) throw spawnErr;
      return realExec(cmd, args, opts as never);
    }) as Exec;

    const store = await f.makeStore(spawnFailExec);
    await expect(store.publish({
      operationId: 'op-spawn', candidate: edit.candidate, prefix: 'skills/c', expectedPathRevision: null, metadata: 'm',
    })).rejects.toBe(spawnErr);
  });

  it('audit.write 抛错 → stderr fallback 留证（原诊断+观察错误），Git 成功值保持', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const repositoryDir = path.join(tmpDir, 'repo');
      const workspaceParent = path.join(tmpDir, 'ws-parent');
      fsSync.mkdirSync(repositoryDir, { recursive: true });
      const { audit } = makeAudit();
      const brokenAudit = {
        ...audit,
        write: () => { throw new Error('audit medium broken'); },
      };
      const fs = new NodeFileSystem({ baseDir: repositoryDir });
      // open + readPublished 全程警告注入且审计介质失败：Git 成功值不被覆盖
      const store = await createVersionStore({ repositoryDir, workspaceParent, fs, audit: brokenAudit, exec: warningExec() });
      const published = await store.readPublished();
      expect(published).toBe(git(repositoryDir, 'rev-parse', 'refs/version/published'));

      const fallbackLines = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.includes('snapshot_git_stderr_audit_failed'));
      expect(fallbackLines.length).toBeGreaterThan(0);
      const payload = JSON.parse(fallbackLines[0]) as { dir: string; stderr: string; error: string };
      expect(payload.dir).toBe(repositoryDir);
      expect(payload.stderr).toContain(WARNING.trim());
      expect(payload.error).toContain('audit medium broken');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
