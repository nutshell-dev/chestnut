/**
 * Phase 1934 Step F（F-10）：Snapshot 发布对账——历史查询未知与未找到分离。
 *
 * 覆盖：
 * ① 发布已生效但本地记录未完成（prepared/无 attempts，twin 窗口）时 git log 非零：
 *    必须抛 git_error，ref/候选/记录不变，绝不写 completed conflict
 * ② 撤销故障后同 operationId 重放恢复既有 published（twin 胜）
 * ③ git log 成功但未命中（无 twin）正常走路径基准比对（新 operation 可发布）
 * ④ spawn 级故障（无 exitCode）原样传播，不包装为 git_error
 * ⑤ git log 成功但输出非法（无可解析条目）拒绝，不按「未找到」继续
 * 反向三项：
 * R1 真正路径冲突（git log 健康）仍 conflict
 * R2 同幂等键不同输入仍 invalid_argument
 * R3 查询失败不清 .git/候选/历史（ref 与候选 commit 均可达）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fsSync from 'fs';
import * as path from 'path';
import { createVersionStore, VersionStoreError } from '../../../src/foundation/snapshot/index.js';
import type { VersionId, VersionStore } from '../../../src/foundation/snapshot/index.js';
import { exec as realExec, ProcessExecError } from '../../../src/foundation/process-exec/index.js';
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

/** publish 记录相对 repositoryDir 的稳定路径（与 version-store STATE_DIR 布局一致）。 */
function publishRecordAbsPath(repositoryDir: string, operationId: string): string {
  const opHash = createHash('sha256').update(`publish:${operationId}`).digest('hex');
  return path.join(repositoryDir, '.git', 'version-store', 'publishes', `${opHash}.json`);
}

describe.skipIf(!gitAvailable)('version-store 发布对账查询失败（phase 1934 Step F）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('version-store-f10-');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  async function makeFixture() {
    const repositoryDir = path.join(tmpDir, 'repo');
    const workspaceParent = path.join(tmpDir, 'ws-parent');
    fsSync.mkdirSync(repositoryDir, { recursive: true });
    const { audit, events } = makeAudit();
    let counter = 0;

    async function makeStore(exec?: Exec): Promise<VersionStore> {
      const fs = new NodeFileSystem({ baseDir: repositoryDir });
      return createVersionStore({ repositoryDir, workspaceParent, fs, audit, ...(exec !== undefined ? { exec } : {}) });
    }

    const fixture = {
      repositoryDir,
      events,
      makeStore,
      published: () => git(repositoryDir, 'rev-parse', 'refs/version/published'),
      pathRev: (prefix: string) => {
        const out = git(repositoryDir, 'rev-list', '--first-parent', '-n', '1', 'refs/version/published', '--', prefix);
        return out === '' ? null : out;
      },
      beginEdit: async (base: VersionId, opTag: string, files: Record<string, string>) => {
        const s = await makeStore();
        const ws = await s.begin({ operationId: `${opTag}-begin-${counter++}`, base });
        for (const [rel, content] of Object.entries(files)) {
          const abs = path.join(ws.path, rel);
          fsSync.mkdirSync(path.dirname(abs), { recursive: true });
          fsSync.writeFileSync(abs, content);
        }
        const candidate = await s.save({ workspaceId: ws.id, operationId: `${opTag}-save`, message: `edit ${opTag}` });
        return { candidate };
      },
      publish: async (
        exec: Exec | undefined,
        input: { operationId: string; candidate: VersionId; prefix: string; expectedPathRevision: VersionId | null; metadata: string },
      ) => {
        const store = await makeStore(exec);
        return store.publish(input);
      },
    };
    // 初始化库
    await makeStore();
    return fixture;
  }

  /** git log 故障注入 exec 包装：armed 时对 log 子命令抛非零退出。 */
  function logFailExec(armed: { value: boolean }): Exec {
    return (async (cmd: string, args: string[], opts: unknown) => {
      if (armed.value && cmd === 'git' && args.includes('log')) {
        throw new ProcessExecError({ message: 'git log failed', output: 'fatal: unable to read log', exitCode: 128 });
      }
      return realExec(cmd, args, opts as never);
    }) as Exec;
  }

  it('①② 发布已生效但记录未完成 + git log 非零 → git_error、零 completed conflict；故障撤销后重放恢复 published', async () => {
    const f = await makeFixture();
    // seed：prefix 首次发布
    const seedBase = f.published() as VersionId;
    const seedEdit = await f.beginEdit(seedBase, 'seed', { 'skills/a/SKILL.md': 'v1\n' });
    const seedResult = await f.publish(undefined, {
      operationId: 'op-seed', candidate: seedEdit.candidate, prefix: 'skills/a',
      expectedPathRevision: null, metadata: 'seed',
    });
    expect(seedResult.kind).toBe('published');

    // twin：同 operationId 的发布提交已在历史中（模拟另一进程/twin 完成）
    const twinBase = f.published() as VersionId;
    const twinEdit = await f.beginEdit(twinBase, 'twin', { 'skills/a/SKILL.md': 'v2\n' });
    const twinInput = {
      operationId: 'op-twin', candidate: twinEdit.candidate, prefix: 'skills/a',
      expectedPathRevision: f.pathRev('skills/a') as VersionId, metadata: 'twin',
    };
    const twinResult = await f.publish(undefined, twinInput);
    expect(twinResult.kind).toBe('published');
    const publishedV1 = f.published();

    // 模拟「发布已生效但本地记录未完成」：prepared 且无 attempts（twin 窗口合法状态）
    const recPath = publishRecordAbsPath(f.repositoryDir, 'op-twin');
    const completedRec = JSON.parse(fsSync.readFileSync(recPath, 'utf8'));
    expect(completedRec.status).toBe('completed');
    fsSync.writeFileSync(recPath, JSON.stringify({ ...completedRec, status: 'prepared', attempts: [], result: undefined }));

    // 重放时 git log 非零 → 必须 git_error；旧行为 fall through 写 completed conflict
    const armed = { value: true };
    await expect(f.publish(logFailExec(armed), twinInput)).rejects.toSatisfy(
      (e) => e instanceof VersionStoreError && e.kind === 'git_error',
    );

    // 断言事实不变：ref 未动、记录仍 prepared、无 conflict 审计、无 completed 记录
    expect(f.published()).toBe(publishedV1);
    const recAfterFail = JSON.parse(fsSync.readFileSync(recPath, 'utf8'));
    expect(recAfterFail.status).toBe('prepared');
    expect(recAfterFail.result).toBeUndefined();
    expect(f.events.filter(e => e[0] === 'snapshot_version_publish_conflict')).toHaveLength(0);

    // R3：候选 commit 与历史均未清理
    expect(git(f.repositoryDir, 'cat-file', '-t', twinEdit.candidate)).toBe('commit');

    // ② 撤销故障：同 operationId 重放恢复既有 published（twin 胜），版本即首次发布
    armed.value = false;
    const recovered = await f.publish(undefined, twinInput);
    expect(recovered).toEqual({ kind: 'published', version: publishedV1 });
    const recAfterRecovery = JSON.parse(fsSync.readFileSync(recPath, 'utf8'));
    expect(recAfterRecovery.status).toBe('completed');
    expect(recAfterRecovery.result.kind).toBe('published');
    expect(recAfterRecovery.result.version).toBe(publishedV1);
  });

  it('③ git log 成功但未命中（无 twin）→ 正常按路径基准发布新 operation', async () => {
    const f = await makeFixture();
    const base = f.published() as VersionId;
    const edit = await f.beginEdit(base, 'fresh', { 'skills/b/SKILL.md': 'b1\n' });
    const result = await f.publish(undefined, {
      operationId: 'op-fresh', candidate: edit.candidate, prefix: 'skills/b',
      expectedPathRevision: null, metadata: 'fresh',
    });
    expect(result.kind).toBe('published');
  });

  it('④ spawn 级故障（无 exitCode）原样传播，不包装为 git_error', async () => {
    const f = await makeFixture();
    const base = f.published() as VersionId;
    const edit = await f.beginEdit(base, 'spawn', { 'skills/c/SKILL.md': 'c1\n' });
    const spawnErr = new Error('spawn git ENOENT');
    const spawnFailExec: Exec = (async (cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'git' && args.includes('log')) throw spawnErr;
      return realExec(cmd, args, opts as never);
    }) as Exec;

    await expect(f.publish(spawnFailExec, {
      operationId: 'op-spawn', candidate: edit.candidate, prefix: 'skills/c',
      expectedPathRevision: null, metadata: 'spawn',
    })).rejects.toBe(spawnErr);
    // 记录保持 prepared（查询失败不完成任何方向）
    const rec = JSON.parse(fsSync.readFileSync(publishRecordAbsPath(f.repositoryDir, 'op-spawn'), 'utf8'));
    expect(rec.status).toBe('prepared');
  });

  it('⑤ git log 成功但输出非法 → git_error，不按「未找到」继续', async () => {
    const f = await makeFixture();
    const base = f.published() as VersionId;
    const edit = await f.beginEdit(base, 'garbage', { 'skills/d/SKILL.md': 'd1\n' });
    const garbageExec: Exec = (async (cmd: string, args: string[], opts: unknown) => {
      if (cmd === 'git' && args.includes('log')) {
        return { output: '\0not-a-sha\0broken\0', stdout: '\0not-a-sha\0broken\0', stderr: '' };
      }
      return realExec(cmd, args, opts as never);
    }) as Exec;

    await expect(f.publish(garbageExec, {
      operationId: 'op-garbage', candidate: edit.candidate, prefix: 'skills/d',
      expectedPathRevision: null, metadata: 'garbage',
    })).rejects.toSatisfy(
      (e) => e instanceof VersionStoreError && e.kind === 'git_error',
    );
    const rec = JSON.parse(fsSync.readFileSync(publishRecordAbsPath(f.repositoryDir, 'op-garbage'), 'utf8'));
    expect(rec.status).toBe('prepared');
  });

  it('R1 真正路径冲突（git log 健康）仍 conflict', async () => {
    const f = await makeFixture();
    // 先推进 prefix skills/a 的 pathRevision
    const base = f.published() as VersionId;
    const e1 = await f.beginEdit(base, 'r1-seed', { 'skills/a/SKILL.md': 'v1\n' });
    const r1 = await f.publish(undefined, {
      operationId: 'op-r1-seed', candidate: e1.candidate, prefix: 'skills/a',
      expectedPathRevision: null, metadata: 'r1 seed',
    });
    expect(r1.kind).toBe('published');

    // 基于旧 base 的候选 + 过期 expectedPathRevision（null）→ 真实路径冲突
    const e2 = await f.beginEdit(base, 'r1-stale', { 'skills/a/SKILL.md': 'v1-alt\n' });
    const stale = await f.publish(undefined, {
      operationId: 'op-r1-stale', candidate: e2.candidate, prefix: 'skills/a',
      expectedPathRevision: null, metadata: 'r1 stale',
    });
    expect(stale.kind).toBe('conflict');
  });

  it('R2 同幂等键不同输入仍 invalid_argument', async () => {
    const f = await makeFixture();
    const base = f.published() as VersionId;
    const edit = await f.beginEdit(base, 'r2', { 'skills/e/SKILL.md': 'e1\n' });
    const first = await f.publish(undefined, {
      operationId: 'op-r2', candidate: edit.candidate, prefix: 'skills/e',
      expectedPathRevision: null, metadata: 'first',
    });
    expect(first.kind).toBe('published');

    await expect(f.publish(undefined, {
      operationId: 'op-r2', candidate: edit.candidate, prefix: 'skills/e',
      expectedPathRevision: null, metadata: 'drifted',
    })).rejects.toSatisfy(
      (e) => e instanceof VersionStoreError && e.kind === 'invalid_argument',
    );
  });
});
