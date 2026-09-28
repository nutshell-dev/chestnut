/**
 * Phase 1919 Step C：技能分支编辑事务并发契约测试（真实 Git）。
 *
 * - 同技能并发编辑（即使改不同文件）：一方发布，晚到者持久冲突、候选保留可读，
 *   晚提交绝不覆盖已发布内容（不同文件不算不冲突）
 * - 新建同名技能并发：先发布者胜，晚到者 absent 基准过期 → conflict
 * - 不同技能并发编辑可双双发布
 * - 重复 submit（含重启后）幂等返回首次事实，不重复发布
 * - retry 从最新版本新建分支链接 parentEditId（不 reset 原分支、不强推旧候选）
 * - cancel 先保存可保存内容再登记；范围违规 / SKILL.md 缺失 typed 拒绝且候选保留
 * - requestId 幂等：重放返回首次编辑事实，输入漂移 typed 拒绝
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import {
  createSkillVersions,
  type SkillBasis,
  type SkillEditHandle,
  type SkillVersions,
  type SkillVersionsOptions,
} from '../../../src/foundation/skill-system/index.js';
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

const SKILL_MD = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`;
const basis: SkillBasis = { actor: 'test-agent', reason: 'concurrent edit test', sourceRefs: ['ref-1'] };

describe.skipIf(!gitAvailable)('技能分支编辑事务：并发（phase 1919 Step C）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-edit-c-');
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

  async function makeService(opts?: { exec?: SkillVersionsOptions['exec'] }): Promise<SkillVersions> {
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    return createSkillVersions({
      repositoryDir: repositoryDir(),
      workspaceParent: workspaceParent(),
      stateDir: stateDir(),
      fsFactory,
      audit: makeAudit().audit,
      exec: opts?.exec,
    });
  }

  /** 基线技能：alpha（SKILL.md + extra.md）、beta（SKILL.md）；在首次服务启动前播种 */
  function seedBaseline(): void {
    const alpha = path.join(repositoryDir(), 'alpha');
    fsSync.mkdirSync(alpha, { recursive: true });
    fsSync.writeFileSync(path.join(alpha, 'SKILL.md'), SKILL_MD('alpha', '# Alpha orig\n'));
    fsSync.writeFileSync(path.join(alpha, 'extra.md'), 'EXTRA-ORIG\n');
    const beta = path.join(repositoryDir(), 'beta');
    fsSync.mkdirSync(beta, { recursive: true });
    fsSync.writeFileSync(path.join(beta, 'SKILL.md'), SKILL_MD('beta', '# Beta orig\n'));
  }

  function writeWsFile(handle: SkillEditHandle, rel: string, content: string): void {
    const abs = path.join(handle.path, rel);
    fsSync.mkdirSync(path.dirname(abs), { recursive: true });
    fsSync.writeFileSync(abs, content);
  }

  /** exec 屏障：match 命中且 armed 时先执行 hook 再放行真实 git（确定性并发交错） */
  async function barrierExec(
    ref: { armed: boolean },
    match: (args: string[]) => boolean,
    hook: () => Promise<void>,
  ): Promise<SkillVersionsOptions['exec']> {
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;
    return (async (file: string, args: string[], opts: unknown) => {
      if (ref.armed && match(args)) {
        ref.armed = false;
        await hook();
      }
      return realExec(file as 'git', args, opts as never);
    }) as SkillVersionsOptions['exec'];
  }

  it('同技能并发编辑（不同文件）：一方发布，晚到者 conflict 候选保留，晚提交不覆盖', async () => {
    seedBaseline();
    const svcA = await makeService();
    const editA = await svcA.beginEdit({ skillName: 'alpha', requestId: 'req-alpha-A', basis });
    // 屏障：B 的 publish commit-tree 时刻让 A 完整发布 → B 的 CAS 落空 → 重判 conflict
    const ref = { armed: true };
    const svcB = await makeService({
      exec: await barrierExec(
        ref,
        (args) => args.includes('commit-tree') && args.some(a => typeof a === 'string' && a.startsWith('publish alpha')),
        async () => {
          const rA = await svcA.submitEdit(editA.editId);
          expect(rA.kind).toBe('published');
        },
      ),
    });
    const editB = await svcB.beginEdit({ skillName: 'alpha', requestId: 'req-alpha-B', basis });
    expect(editB.base).toBe(editA.base);
    expect(editA.basePathRevision).toMatch(/^[0-9a-f]{40}$/);
    expect(editA.path.startsWith(workspaceParent())).toBe(true);
    expect(editA.path.endsWith(`${path.sep}alpha`)).toBe(true);

    // A 改 SKILL.md；B 只改 extra.md（不同文件——仍按技能路径基准判冲突）
    writeWsFile(editA, 'SKILL.md', SKILL_MD('alpha', '# Alpha by A\n'));
    writeWsFile(editB, 'extra.md', 'EXTRA-B\n');

    const rB = await svcB.submitEdit(editB.editId);
    expect(rB.kind).toBe('conflict');
    if (rB.kind === 'conflict') {
      expect(rB.editId).toBe(editB.editId);
      expect(rB.base).toBe(editB.base);
      expect(rB.current).toMatch(/^[0-9a-f]{40}$/);
      expect(rB.current).not.toBe(editB.base);
      // 冲突候选保留可达（不删除 loser 分支）
      expect(git(repositoryDir(), 'show', `${rB.candidate}:alpha/extra.md`)).toContain('EXTRA-B');
    }

    // 晚提交不覆盖：published 的 extra.md 仍是原版，SKILL.md 是 A 的版本
    // （Phase 1921 Step D：固定版本物化经 exportSkillVersion 到独占目录）
    const pub = await svcA.readPublished('alpha');
    const exportDir = path.join(tmpDir, 'export-alpha-published');
    await svcA.exportSkillVersion({ name: 'alpha', version: pub.sourceVersion, destination: exportDir });
    expect(fsSync.readFileSync(path.join(exportDir, 'extra.md'), 'utf8')).toBe('EXTRA-ORIG\n');
    expect(await svcA.loadPublished('alpha')).toContain('# Alpha by A');

    // 重复 submit 幂等：同一冲突结果（不重复发布、不伪造）
    const replay = await svcB.submitEdit(editB.editId);
    expect(replay).toEqual(rB);
    // 事务状态持久可查
    const info = await svcB.editStatus(editB.editId);
    expect(info.status).toBe('conflict');
    expect(info.current).toBe((rB as { current: string }).current);
  });

  it('新建同名技能并发：absent 基准过期 → conflict，候选保留', async () => {
    const svcA = await makeService();

    const editA = await svcA.beginEdit({ skillName: 'gamma', requestId: 'req-gamma-A', basis });
    const ref = { armed: true };
    const svcB = await makeService({
      exec: await barrierExec(
        ref,
        (args) => args.includes('commit-tree') && args.some(a => typeof a === 'string' && a.startsWith('publish gamma')),
        async () => {
          const rA = await svcA.submitEdit(editA.editId);
          expect(rA.kind).toBe('published');
        },
      ),
    });
    const editB = await svcB.beginEdit({ skillName: 'gamma', requestId: 'req-gamma-B', basis });
    expect(editA.basePathRevision).toBeNull();
    expect(editB.basePathRevision).toBeNull();
    writeWsFile(editA, 'SKILL.md', SKILL_MD('gamma', '# Gamma by A\n'));
    writeWsFile(editB, 'SKILL.md', SKILL_MD('gamma', '# Gamma by B\n'));

    const rB = await svcB.submitEdit(editB.editId);
    expect(rB.kind).toBe('conflict');
    if (rB.kind === 'conflict') {
      expect(git(repositoryDir(), 'show', `${rB.candidate}:gamma/SKILL.md`)).toContain('# Gamma by B');
    }
    expect(await svcA.loadPublished('gamma')).toContain('# Gamma by A');
  });

  it('不同技能并发编辑可双双发布', async () => {
    seedBaseline();
    const svcA = await makeService();
    const svcB = await makeService();

    const editA = await svcA.beginEdit({ skillName: 'alpha', requestId: 'req-x-alpha', basis });
    const editB = await svcB.beginEdit({ skillName: 'beta', requestId: 'req-x-beta', basis });
    writeWsFile(editA, 'SKILL.md', SKILL_MD('alpha', '# Alpha v2\n'));
    writeWsFile(editB, 'SKILL.md', SKILL_MD('beta', '# Beta v2\n'));

    const rA = await svcA.submitEdit(editA.editId);
    const rB = await svcB.submitEdit(editB.editId);
    expect(rA.kind).toBe('published');
    expect(rB.kind).toBe('published');
    expect(await svcA.loadPublished('alpha')).toContain('# Alpha v2');
    expect(await svcA.loadPublished('beta')).toContain('# Beta v2');
  });

  it('重复 submit 与重启重放幂等：返回首次事实，不重复发布', async () => {
    seedBaseline();
    const svc = await makeService();
    const edit = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-replay', basis });
    writeWsFile(edit, 'SKILL.md', SKILL_MD('alpha', '# Alpha replay\n'));

    const r1 = await svc.submitEdit(edit.editId);
    expect(r1.kind).toBe('published');
    const publishedHead = git(repositoryDir(), 'rev-parse', 'refs/version/published');

    // 同进程重复 submit：同结果，published 不推进
    const r2 = await svc.submitEdit(edit.editId);
    expect(r2).toEqual(r1);
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(publishedHead);

    // 重启（新服务实例）重放：同结果，published 不推进，状态不误报
    const svc2 = await makeService();
    const r3 = await svc2.submitEdit(edit.editId);
    expect(r3).toEqual(r1);
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(publishedHead);
    const info = await svc2.editStatus(edit.editId);
    expect(info.status).toBe('published');
    expect(info.version).toBe((r1 as { version: string }).version);
    expect(info.basis).toEqual(basis);
    expect(info.publishOperationId).toBe(`edit-publish-${edit.editId}`);
  });

  it('retry 从最新版本新建分支链接 parentEditId：不 reset 原分支、不强推旧候选', async () => {
    seedBaseline();
    const svc = await makeService();
    const editA = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-r-A', basis });
    const editB = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-r-B', basis });
    writeWsFile(editA, 'SKILL.md', SKILL_MD('alpha', '# Alpha by A\n'));
    writeWsFile(editB, 'SKILL.md', SKILL_MD('alpha', '# Alpha by B\n'));

    // 顺序提交：A 先发布后 B 的路径基准已过期（无需屏障的确定性冲突）
    expect((await svc.submitEdit(editA.editId)).kind).toBe('published');
    const rB = await svc.submitEdit(editB.editId);
    expect(rB.kind).toBe('conflict');

    // retry：新分支基于最新 published（含 A 的内容），parentEditId 链接旧编辑
    const handle2 = await svc.retryEdit({ editId: editB.editId, requestId: 'req-r-B2' });
    expect(handle2.editId).not.toBe(editB.editId);
    expect(handle2.basePathRevision).not.toBe(editB.basePathRevision);
    expect(fsSync.readFileSync(path.join(handle2.path, 'SKILL.md'), 'utf8')).toContain('# Alpha by A');
    const info2 = await svc.editStatus(handle2.editId);
    expect(info2.parentEditId).toBe(editB.editId);
    expect(info2.status).toBe('editing');

    // retry 幂等重放：同 requestId 返回同一编辑
    const replay = await svc.retryEdit({ editId: editB.editId, requestId: 'req-r-B2' });
    expect(replay.editId).toBe(handle2.editId);

    // 在新分支上重做修改 → 发布成功；旧冲突候选仍可读（不删除 loser 分支）
    writeWsFile(handle2, 'SKILL.md', SKILL_MD('alpha', '# Alpha by B2\n'));
    const r2 = await svc.submitEdit(handle2.editId);
    expect(r2.kind).toBe('published');
    expect(await svc.loadPublished('alpha')).toContain('# Alpha by B2');
    if (rB.kind === 'conflict') {
      expect(git(repositoryDir(), 'show', `${rB.candidate}:alpha/SKILL.md`)).toContain('# Alpha by B');
    }

    // 非 conflict 状态不允许 retry
    await expect(svc.retryEdit({ editId: handle2.editId, requestId: 'req-r-B3' })).rejects.toMatchObject({
      name: 'SkillVersionError', kind: 'invalid_argument',
    });
  });

  it('cancel 先保存可保存内容再登记；取消后 submit typed 拒绝；幂等', async () => {
    seedBaseline();
    const svc = await makeService();
    const edit = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-cancel', basis });
    writeWsFile(edit, 'SKILL.md', SKILL_MD('alpha', '# Alpha cancelled work\n'));

    const info = await svc.cancelEdit(edit.editId);
    expect(info.status).toBe('cancelled');
    expect(info.candidate).toMatch(/^[0-9a-f]{40}$/);
    // 取消前保存的候选长期可读
    expect(git(repositoryDir(), 'show', `${info.candidate}:alpha/SKILL.md`)).toContain('# Alpha cancelled work');

    // 幂等：重复取消返回同一事实
    const again = await svc.cancelEdit(edit.editId);
    expect(again).toEqual(info);

    // 取消后不能提交；已发布/冲突编辑不能取消
    await expect(svc.submitEdit(edit.editId)).rejects.toMatchObject({
      name: 'SkillVersionError', kind: 'invalid_argument',
    });
    const done = await svc.beginEdit({ skillName: 'beta', requestId: 'req-cancel-done', basis });
    writeWsFile(done, 'SKILL.md', SKILL_MD('beta', '# Beta v2\n'));
    expect((await svc.submitEdit(done.editId)).kind).toBe('published');
    await expect(svc.cancelEdit(done.editId)).rejects.toMatchObject({
      name: 'SkillVersionError', kind: 'invalid_argument',
    });
  });

  it('requestId 幂等：重放返回首次编辑事实，输入漂移 typed 拒绝', async () => {
    seedBaseline();
    const svc = await makeService();
    const handle = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-idem', basis });
    const replay = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-idem', basis });
    expect(replay.editId).toBe(handle.editId);
    expect(replay.path).toBe(handle.path);

    await expect(
      svc.beginEdit({ skillName: 'alpha', requestId: 'req-idem', basis: { ...basis, reason: 'different' } }),
    ).rejects.toMatchObject({ name: 'SkillVersionError', kind: 'invalid_argument' });
    await expect(
      svc.beginEdit({ skillName: 'beta', requestId: 'req-idem', basis }),
    ).rejects.toMatchObject({ name: 'SkillVersionError', kind: 'invalid_argument' });
    await expect(
      svc.beginEdit({ skillName: 'alpha', requestId: '', basis }),
    ).rejects.toMatchObject({ name: 'SkillVersionError', kind: 'invalid_argument' });
  });

  it('范围违规（改动其他技能子树）：typed 拒绝且候选保留，可取消留证', async () => {
    seedBaseline();
    const svc = await makeService();
    const edit = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-scope', basis });
    writeWsFile(edit, 'SKILL.md', SKILL_MD('alpha', '# Alpha scoped\n'));
    // 候选越界改动 beta 子树（工作区根 = handle.path 上一级）
    const wsRoot = path.dirname(edit.path);
    fsSync.writeFileSync(path.join(wsRoot, 'beta', 'SKILL.md'), SKILL_MD('beta', '# Beta hijacked\n'));

    await expect(svc.submitEdit(edit.editId)).rejects.toMatchObject({
      name: 'SkillVersionError', kind: 'invalid_argument',
    });
    // 候选保留：状态 saved、候选可读、不伪装终态
    const info = await svc.editStatus(edit.editId);
    expect(info.status).toBe('saved');
    expect(info.candidate).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repositoryDir(), 'show', `${info.candidate}:beta/SKILL.md`)).toContain('# Beta hijacked');
    // 已发布 beta 不受影响
    expect(await svc.loadPublished('beta')).toContain('# Beta orig');
    // 取消留证（候选保留）
    const cancelled = await svc.cancelEdit(edit.editId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.candidate).toBe(info.candidate);
  });

  it('候选 SKILL.md 缺失：校验失败 typed 拒绝、候选保留、audit 留证', async () => {
    seedBaseline();
    const { audit, events } = makeAudit();
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    const svc = await createSkillVersions({
      repositoryDir: repositoryDir(),
      workspaceParent: workspaceParent(),
      stateDir: stateDir(),
      fsFactory,
      audit,
    });

    const edit = await svc.beginEdit({ skillName: 'alpha', requestId: 'req-nomd', basis });
    fsSync.rmSync(path.join(edit.path, 'SKILL.md'));

    await expect(svc.submitEdit(edit.editId)).rejects.toMatchObject({
      name: 'SkillVersionError', kind: 'invalid_argument',
    });
    const info = await svc.editStatus(edit.editId);
    expect(info.status).toBe('saved');
    expect(info.candidate).toMatch(/^[0-9a-f]{40}$/);
    expect(events.some(e => e[0] === 'skill_version_edit_validation_failed')).toBe(true);
    expect(events.some(e => e[0] === 'skill_version_edit_began')).toBe(true);
  });
});
