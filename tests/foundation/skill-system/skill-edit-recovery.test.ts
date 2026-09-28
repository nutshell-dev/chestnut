/**
 * Phase 1919 Step C：技能分支编辑事务崩溃恢复契约测试（真实 Git）。
 *
 * - CAS 后进程中断（业务事务记录未及落盘）：重启经稳定 publishOperationId +
 *   Snapshot 操作记录对账为 published，不误报未发布、不重复发布
 * - begin 中断（preparing）：同 requestId 重放续作补齐工作区，不重建事务
 * - busy（CAS 有界重试耗尽）：持久呈现为 saved 待重试（候选 + operationId 在场），
 *   绝不伪装成语义冲突；解锁后重提续作发布
 * - 重启后 editHistory 事实不丢（新→旧、按技能过滤）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import {
  createSkillVersions,
  skillEditId,
  type SkillBasis,
  type SkillEditHandle,
  type SkillVersions,
  type SkillVersionsOptions,
} from '../../../src/foundation/skill-system/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

const SKILL_MD = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`;
const basis: SkillBasis = { actor: 'test-agent', reason: 'recovery test', sourceRefs: ['ref-r'] };

describe.skipIf(!gitAvailable)('技能分支编辑事务：崩溃恢复（phase 1919 Step C）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-edit-r-');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  const repositoryDir = () => path.join(tmpDir, 'motion', 'clawspace', 'dispatch-skills');
  const workspaceParent = () => path.join(tmpDir, 'motion', 'clawspace', '.dispatch-workspaces');
  const stateDir = () => path.join(tmpDir, 'motion', 'clawspace', '.dispatch-version-state');

  function fsFactory(baseDir: string): NodeFileSystem {
    return new NodeFileSystem({ baseDir });
  }

  async function makeService(opts?: {
    exec?: SkillVersionsOptions['exec'];
    fsFactory?: (baseDir: string) => FileSystem;
    audit?: SkillVersionsOptions['audit'];
  }): Promise<SkillVersions> {
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    return createSkillVersions({
      repositoryDir: repositoryDir(),
      workspaceParent: workspaceParent(),
      stateDir: stateDir(),
      fsFactory: opts?.fsFactory ?? fsFactory,
      audit: opts?.audit ?? makeAudit().audit,
      exec: opts?.exec,
    });
  }

  function seedBaseline(): void {
    const alpha = path.join(repositoryDir(), 'alpha');
    fsSync.mkdirSync(alpha, { recursive: true });
    fsSync.writeFileSync(path.join(alpha, 'SKILL.md'), SKILL_MD('alpha', '# Alpha orig\n'));
    const beta = path.join(repositoryDir(), 'beta');
    fsSync.mkdirSync(beta, { recursive: true });
    fsSync.writeFileSync(path.join(beta, 'SKILL.md'), SKILL_MD('beta', '# Beta orig\n'));
  }

  function writeWsFile(handle: SkillEditHandle, rel: string, content: string): void {
    const abs = path.join(handle.path, rel);
    fsSync.mkdirSync(path.dirname(abs), { recursive: true });
    fsSync.writeFileSync(abs, content);
  }

  it('CAS 后进程中断：重启 editStatus 经操作记录对账为 published，不重复发布', async () => {
    seedBaseline();
    // 故障注入：仅在事务记录写入 published 终态时抛错一次（模拟该瞬间进程死亡——
    // Snapshot 发布已完成，业务记录仍停留 saved + publishOperationId）
    const crash = { armed: true };
    class CrashFs extends NodeFileSystem {
      override async writeAtomic(rel: string, content: string) {
        if (crash.armed && rel.startsWith('edits/') && content.includes('"status": "published"')) {
          crash.armed = false;
          throw new Error('simulated process death after publish CAS');
        }
        return super.writeAtomic(rel, content);
      }
    }
    const svc1 = await makeService({ fsFactory: (baseDir) => new CrashFs({ baseDir }) });
    const edit = await svc1.beginEdit({ skillName: 'alpha', requestId: 'req-crash', basis });
    writeWsFile(edit, 'SKILL.md', SKILL_MD('alpha', '# Alpha crash window\n'));
    await expect(svc1.submitEdit(edit.editId)).rejects.toThrow('simulated process death');

    // 发布权威（Snapshot）已推进；业务记录仍 saved（崩溃现场保留）
    const publishedHead = git(repositoryDir(), 'rev-parse', 'refs/version/published');
    const svc2 = await makeService();
    const raw = await svc2.editHistory('alpha');
    expect(raw[0].status).toBe('published'); // editHistory 对账后呈现
    expect(raw[0].version).toBe(git(repositoryDir(), 'rev-list', '--first-parent', '-n', '1', publishedHead, '--', 'alpha'));

    const info = await svc2.editStatus(edit.editId);
    expect(info.status).toBe('published');
    expect(info.version).toMatch(/^[0-9a-f]{40}$/);
    // 不重复发布：对账不推进 published ref
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(publishedHead);
    // 新内容可经固定版本读取
    expect(await svc2.loadPublished('alpha')).toContain('# Alpha crash window');
    // 重提 submit：返回同一发布事实，仍不推进
    const replay = await svc2.submitEdit(edit.editId);
    expect(replay).toEqual({ kind: 'published', editId: edit.editId, version: info.version });
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(publishedHead);
  });

  it('begin 中断（preparing）：同 requestId 重放续作补齐工作区，editId 不变', async () => {
    seedBaseline();
    // 故障注入：首个 git worktree add 失败（模拟工作区创建瞬间进程死亡）。
    // 服务创建（baseline 迁移）也用 worktree add——创建完成后再 armed
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;
    const crash = { armed: false };
    const crashExec = (async (file: string, args: string[], opts: unknown) => {
      if (crash.armed && args.includes('worktree') && args.includes('add')) {
        crash.armed = false;
        const err = new Error('simulated death during worktree add') as Error & { exitCode: number; output: string };
        err.exitCode = 128;
        err.output = 'simulated death during worktree add';
        throw err;
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;

    const svc1 = await makeService({ exec: crashExec });
    crash.armed = true;
    await expect(svc1.beginEdit({ skillName: 'alpha', requestId: 'req-prepare', basis })).rejects.toThrow();

    // 重启：记录呈现 preparing（不靠内存句柄）；同 requestId 重放续作
    const svc2 = await makeService();
    const editId = skillEditId('req-prepare');
    expect((await svc2.editStatus(editId)).status).toBe('preparing');

    const handle = await svc2.beginEdit({ skillName: 'alpha', requestId: 'req-prepare', basis });
    expect(handle.editId).toBe(editId);
    expect(fsSync.existsSync(handle.path)).toBe(true);
    expect((await svc2.editStatus(editId)).status).toBe('editing');

    // 续作后可正常完成编辑发布
    writeWsFile(handle, 'SKILL.md', SKILL_MD('alpha', '# Alpha resumed\n'));
    const r = await svc2.submitEdit(editId);
    expect(r.kind).toBe('published');
    expect(await svc2.loadPublished('alpha')).toContain('# Alpha resumed');
  });

  it('busy 持久呈现为待重试（saved + publishOperationId），不伪装冲突；解锁续作发布', async () => {
    seedBaseline();
    // 故障注入：published ref 的 CAS（update-ref）持续失败 → 有界重试耗尽 → busy。
    // open() 初始化也用 published CAS——beginEdit 完成后再持有锁
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;
    const lock = { held: false };
    const lockExec = (async (file: string, args: string[], opts: unknown) => {
      if (lock.held && args.includes('update-ref') && args.includes('refs/version/published')) {
        const err = new Error('simulated ref lock contention') as Error & { exitCode: number; output: string };
        err.exitCode = 1;
        err.output = 'cannot lock ref: simulated contention';
        throw err;
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;

    const svc1 = await makeService({ exec: lockExec });
    const edit = await svc1.beginEdit({ skillName: 'alpha', requestId: 'req-busy', basis });
    writeWsFile(edit, 'SKILL.md', SKILL_MD('alpha', '# Alpha busy\n'));
    lock.held = true;
    const r = await svc1.submitEdit(edit.editId);
    expect(r.kind).toBe('busy');
    if (r.kind !== 'busy') return;
    expect(r.operationId).toBe(`edit-publish-${edit.editId}`);

    // 持久呈现：saved + publishOperationId 在场、候选保留——绝不伪装成语义冲突
    const info1 = await svc1.editStatus(edit.editId);
    expect(info1.status).toBe('saved');
    expect(info1.publishOperationId).toBe(r.operationId);
    expect(info1.candidate).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repositoryDir(), 'show', `${info1.candidate}:alpha/SKILL.md`)).toContain('# Alpha busy');

    // 重启查询不误报：Snapshot 记录 prepared 未完成，业务状态保持 saved
    const svc2 = await makeService({ exec: lockExec });
    expect((await svc2.editStatus(edit.editId)).status).toBe('saved');

    // 解锁后重提续作：同一 publishOperationId 恢复发布
    lock.held = false;
    const svc3 = await makeService();
    const r2 = await svc3.submitEdit(edit.editId);
    expect(r2.kind).toBe('published');
    expect(await svc3.loadPublished('alpha')).toContain('# Alpha busy');
    expect((await svc3.editStatus(edit.editId)).status).toBe('published');
  });

  it('重启后 editHistory 事实不丢：新→旧排序、按技能过滤、依据原样呈现', async () => {
    seedBaseline();
    const svc1 = await makeService();
    const edit1 = await svc1.beginEdit({ skillName: 'alpha', requestId: 'req-h-1', basis });
    writeWsFile(edit1, 'SKILL.md', SKILL_MD('alpha', '# Alpha h1\n'));
    expect((await svc1.submitEdit(edit1.editId)).kind).toBe('published');
    const edit2 = await svc1.beginEdit({ skillName: 'alpha', requestId: 'req-h-2', basis });
    await svc1.cancelEdit(edit2.editId);
    await svc1.beginEdit({ skillName: 'beta', requestId: 'req-h-3', basis });

    const svc2 = await makeService();
    const alphaHistory = await svc2.editHistory('alpha');
    expect(alphaHistory.map(i => i.editId)).toEqual([edit2.editId, edit1.editId]); // 新→旧
    expect(alphaHistory[0].status).toBe('cancelled');
    expect(alphaHistory[1].status).toBe('published');
    expect(alphaHistory[1].version).toMatch(/^[0-9a-f]{40}$/);
    expect(alphaHistory[1].basis).toEqual(basis);
    expect(alphaHistory[1].parentEditId).toBeNull();

    const all = await svc2.editHistory();
    expect(all).toHaveLength(3);
    expect(all.map(i => i.skillName)).toEqual(['beta', 'alpha', 'alpha']);

    // 未发布技能（beta 仅 begin 未 submit）不误报 published
    const betaEdit = all.find(i => i.skillName === 'beta');
    expect(betaEdit?.status).toBe('editing');
    expect(betaEdit?.version).toBeNull();
  });
});
