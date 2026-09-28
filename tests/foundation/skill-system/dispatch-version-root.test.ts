/**
 * Phase 1919 Step B：dispatch 独立版本根与入口切换（SkillVersions）契约测试。
 *
 * 真实 Git 验证：
 * - 旧 live 树一次性迁移为版本库 baseline（备份 + 迁移记录 + 内容校验；
 *   嵌套 agent repo 内仍建独立根）；重复启动不重建 baseline、不丢历史
 * - 旧活动 intent/marker/staging 在场 → 迁移阻断 loud 失败，不绕过
 * - 全部读取走固定版本物化投影：dirty live 不漏入；.git 不当 payload
 * - import 分支保存 + 条件发布：新版本发布、幂等重放、晚发布者冲突候选保留
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import {
  createSkillVersions,
  SkillVersionError,
  type SkillVersions,
} from '../../../src/foundation/skill-system/index.js';
import type { SkillVersionsOptions } from '../../../src/foundation/skill-system/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createVersionStore } from '../../../src/foundation/snapshot/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

const SKILL_MD = (name: string, desc: string, body: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

describe.skipIf(!gitAvailable)('dispatch 独立版本根与入口切换（phase 1919 Step B）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-versions-b-');
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

  function seedLiveSkill(name: string, body: string): void {
    const dir = path.join(repositoryDir(), name);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD(name, `${name} desc`, body));
  }

  function writeSource(name: string, body: string): string {
    const dir = path.join(tmpDir, 'sources', name);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD(name, `${name} desc`, body));
    return dir;
  }

  const basis = { actor: 'test', reason: 'unit test import', sourceRefs: ['test://fixture'] };

  it('空目录 baseline：版本库建立、无技能、重复启动不重建', async () => {
    const svc = await makeService();
    expect(await svc.formatPublishedForContext()).toContain('No skills loaded');
    await expect(svc.readPublished('nope')).rejects.toMatchObject({ kind: 'not_found' });
    const published = git(repositoryDir(), 'rev-parse', 'refs/version/published');

    const svc2 = await makeService();
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(published);
    await expect(svc2.readPublished('nope')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('旧 live 树一次性迁移：内容不变、备份在场、迁移记录持久化、repo 根字节不动', async () => {
    seedLiveSkill('alpha', '# Alpha v1\n');
    seedLiveSkill('beta', '# Beta v1\n');

    const svc = await makeService();
    const a = await svc.readPublished('alpha');
    expect(a.sourceVersion).toMatch(/^[0-9a-f]{40}$/);
    expect(await svc.loadPublished('alpha')).toContain('# Alpha v1');
    const formatted = await svc.formatPublishedForContext();
    expect(formatted).toContain('alpha');
    expect(formatted).toContain('beta');

    // 迁移记录 + 内容校验 + 备份
    const state = JSON.parse(fsSync.readFileSync(path.join(stateDir(), 'state.json'), 'utf8')) as {
      migration: { phase: string; migrationId: string; contentSha256: string | null; skills: string[] };
      skills: string[];
    };
    expect(state.migration.phase).toBe('ready');
    expect(state.migration.skills).toEqual(['alpha', 'beta']);
    expect(state.migration.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const backups = fsSync.readdirSync(stateDir()).filter(n => n.startsWith('migration-backup-'));
    expect(backups).toHaveLength(1);
    expect(fsSync.readFileSync(path.join(stateDir(), backups[0], 'alpha', 'SKILL.md'), 'utf8')).toContain('# Alpha v1');
    // repo 根旧字节原样保留（不删历史/字节）
    expect(fsSync.readFileSync(path.join(repositoryDir(), 'alpha', 'SKILL.md'), 'utf8')).toContain('# Alpha v1');
    // Phase 1921 Step D：读取结果只含不可变身份（不再有共享投影路径句柄）；
    // 物化经 exportSkillVersion 到调用方独占目录，且绝不落在库内
    expect('materializedPath' in a).toBe(false);
    const exportDir = path.join(tmpDir, 'export-alpha');
    await svc.exportSkillVersion({ name: 'alpha', version: a.sourceVersion, destination: exportDir });
    expect(fsSync.readFileSync(path.join(exportDir, 'SKILL.md'), 'utf8')).toContain('# Alpha v1');
    expect(exportDir.startsWith(repositoryDir())).toBe(false);
  });

  it('嵌套 agent repo 内仍建独立 Git 根', async () => {
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    git(tmpDir, 'init');
    seedLiveSkill('alpha', '# Alpha\n');
    await makeService();
    expect(git(repositoryDir(), 'rev-parse', '--path-format=absolute', '--show-toplevel'))
      .toBe(fsSync.realpathSync(repositoryDir()));
  });

  it('旧活动 marker/staging 在场 → migration_blocked 留证，不绕过', async () => {
    seedLiveSkill('alpha', '# Alpha\n');
    fsSync.writeFileSync(path.join(repositoryDir(), 'alpha', '.skill-publishing'), 'busy');
    const err = await makeService().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillVersionError);
    expect((err as SkillVersionError).kind).toBe('migration_blocked');
    expect((err as SkillVersionError).evidence.some(p => p.includes('.skill-publishing'))).toBe(true);
    // 不绕过：库未建立
    expect(fsSync.existsSync(path.join(repositoryDir(), '.git'))).toBe(false);
  });

  it('旧 staging/trash/srcsnap 隐藏目录在场 → migration_blocked', async () => {
    seedLiveSkill('alpha', '# Alpha\n');
    fsSync.mkdirSync(path.join(repositoryDir(), '.skill-staging-xyz'), { recursive: true });
    const err = await makeService().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillVersionError);
    expect((err as SkillVersionError).kind).toBe('migration_blocked');
    expect(fsSync.existsSync(path.join(repositoryDir(), '.git'))).toBe(false);
  });

  it('已有版本库但无迁移状态 → baseline_failed，不覆盖', async () => {
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    // 非本服务创建的版本库
    await createVersionStore({
      repositoryDir: repositoryDir(),
      workspaceParent: workspaceParent(),
      fs: fsFactory(repositoryDir()),
      audit: makeAudit().audit,
    });
    const err = await makeService().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillVersionError);
    expect((err as SkillVersionError).kind).toBe('baseline_failed');
  });

  it('importSkill：新技能发布、幂等重放同版本、更新产生新版本、重启后历史不丢', async () => {
    const svc = await makeService();
    const srcV1 = writeSource('gamma', '# Gamma v1\n');
    const r1 = await svc.importSkill({ name: 'gamma', source: srcV1, operationId: 'imp-g1', basis });
    expect(r1.kind).toBe('published');

    // 幂等重放：同 operationId 同输入 → 相同版本
    const replay = await svc.importSkill({ name: 'gamma', source: srcV1, operationId: 'imp-g1', basis });
    expect(replay).toEqual(r1);

    // 更新：新 operationId → 新版本；readPublished 随之推进
    const v1 = (await svc.readPublished('gamma')).sourceVersion;
    const srcV2 = writeSource('gamma', '# Gamma v2\n');
    const r2 = await svc.importSkill({ name: 'gamma', source: srcV2, operationId: 'imp-g2', basis });
    expect(r2.kind).toBe('published');
    const v2 = (await svc.readPublished('gamma')).sourceVersion;
    expect(v2).not.toBe(v1);
    expect(await svc.loadPublished('gamma')).toContain('# Gamma v2');
    expect(await svc.formatPublishedForContext()).toContain('gamma');

    // 重启（新实例）：版本与历史保持
    const published = git(repositoryDir(), 'rev-parse', 'refs/version/published');
    const svc2 = await makeService();
    expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(published);
    expect((await svc2.readPublished('gamma')).sourceVersion).toBe(v2);
    expect(await svc2.loadPublished('gamma')).toContain('# Gamma v2');
  });

  it('反向：dirty live 工作区字节绝不漏入固定版本读取', async () => {
    seedLiveSkill('alpha', '# Alpha committed\n');
    const svc = await makeService();
    // 库根工作区被直接改写（旧习惯/意外），没有经版本服务发布
    fsSync.writeFileSync(path.join(repositoryDir(), 'alpha', 'SKILL.md'), SKILL_MD('alpha', 'alpha desc', '# Alpha DIRTY\n'));
    fsSync.writeFileSync(path.join(repositoryDir(), 'alpha', 'stray.txt'), 'dirty\n');

    const a = await svc.readPublished('alpha');
    const exportDir = path.join(tmpDir, 'export-dirty-check');
    await svc.exportSkillVersion({ name: 'alpha', version: a.sourceVersion, destination: exportDir });
    const content = fsSync.readFileSync(path.join(exportDir, 'SKILL.md'), 'utf8');
    expect(content).toContain('# Alpha committed');
    expect(content).not.toContain('DIRTY');
    expect(fsSync.existsSync(path.join(exportDir, 'stray.txt'))).toBe(false);
    expect(await svc.loadPublished('alpha')).toContain('# Alpha committed');
  });

  it('反向：.git 不当 payload——source 含 .git 拒绝；投影/摘要不出现 .git', async () => {
    seedLiveSkill('epsilon', '# Epsilon\n');
    const svc = await makeService();
    const src = writeSource('delta', '# Delta\n');
    fsSync.mkdirSync(path.join(src, '.git'), { recursive: true });
    await expect(svc.importSkill({ name: 'delta', source: src, operationId: 'imp-d1', basis }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });

    const e = await svc.readPublished('epsilon');
    const exportDir = path.join(tmpDir, 'export-epsilon');
    await svc.exportSkillVersion({ name: 'epsilon', version: e.sourceVersion, destination: exportDir });
    expect(fsSync.existsSync(path.join(exportDir, '.git'))).toBe(false);
    expect(await svc.formatPublishedForContext()).not.toContain('.git');
  });

  it('Phase 1921 Step D：读取 v1 后发布 v2，v1 身份导出仍得 v1（版本身份=不可变句柄）', async () => {
    seedLiveSkill('alpha', '# Alpha v1\n');
    const svc = await makeService();
    const v1 = (await svc.readPublished('alpha')).sourceVersion;

    // 后续发布推进到 v2
    const r = await svc.importSkill({ name: 'alpha', source: writeSource('alpha', '# Alpha v2\n'), operationId: 'imp-a2', basis });
    expect(r.kind).toBe('published');
    expect((await svc.readPublished('alpha')).sourceVersion).not.toBe(v1);

    // 旧版本身份导出仍得 v1 字节（不受后续发布影响）；当前读取是 v2
    const dirV1 = path.join(tmpDir, 'export-v1');
    await svc.exportSkillVersion({ name: 'alpha', version: v1, destination: dirV1 });
    expect(fsSync.readFileSync(path.join(dirV1, 'SKILL.md'), 'utf8')).toContain('# Alpha v1');
    expect(await svc.loadPublished('alpha')).toContain('# Alpha v2');
    // 重启后旧身份依然可导出（不可变 commit 跨重启有效）
    const svc2 = await makeService();
    const dirV1b = path.join(tmpDir, 'export-v1-restart');
    await svc2.exportSkillVersion({ name: 'alpha', version: v1, destination: dirV1b });
    expect(fsSync.readFileSync(path.join(dirV1b, 'SKILL.md'), 'utf8')).toContain('# Alpha v1');
  });

  it('import 参数校验：病态技能名/无 SKILL.md/空依据 typed 拒绝', async () => {
    const svc = await makeService();
    const src = writeSource('zeta', '# Zeta\n');
    await expect(svc.importSkill({ name: 'zeta', source: src, operationId: '', basis }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    await expect(svc.importSkill({ name: 'zeta', source: src, operationId: 'imp-z', basis: { actor: '', reason: 'r', sourceRefs: [] } }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    await expect(svc.importSkill({ name: 'Bad_Name', source: src, operationId: 'imp-z0', basis }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    const empty = path.join(tmpDir, 'sources', 'no-skillmd');
    fsSync.mkdirSync(empty, { recursive: true });
    await expect(svc.importSkill({ name: 'zeta', source: empty, operationId: 'imp-z2', basis }))
      .rejects.toMatchObject({ kind: 'invalid_argument' });
    await expect(svc.readPublished('Bad_Name')).rejects.toMatchObject({ kind: 'invalid_argument' });
  });

  it('同技能并发 import：一方发布，晚到者 conflict 且候选保留（确定性屏障）', async () => {
    // 服务 A（正常 exec）先建好库；服务 B 注入 exec 屏障：B 的 publish commit-tree
    // 时刻先让 A 完整发布同技能新版本，B 的 CAS 因此落空 → 重判路径基准 → conflict
    await makeService();
    // 同名技能不同源目录（技能名 = source basename，目录必须区分，否则互相覆写）
    const srcA = writeSource('a/eta', '# Eta from A\n');
    const srcB = writeSource('b/eta', '# Eta from B\n');

    const svcA = await makeService();
    const realExec = (await import('../../../src/foundation/process-exec/index.js')).exec;
    let barrierArmed = true;
    const barrierExec = (async (file: string, args: string[], opts: unknown) => {
      // exec 实参带 --git-dir 前缀：按子命令匹配，只拦 B 的 publish 提交点
      if (barrierArmed && args.includes('commit-tree') && args.some(a => typeof a === 'string' && a.startsWith('publish eta'))) {
        barrierArmed = false;
        const r = await svcA.importSkill({ name: 'eta', source: srcA, operationId: 'imp-eta-A', basis });
        expect(r.kind).toBe('published');
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;
    const svcB = await makeService({ exec: barrierExec });

    const rB = await svcB.importSkill({ name: 'eta', source: srcB, operationId: 'imp-eta-B', basis });
    expect(rB.kind).toBe('conflict');
    if (rB.kind === 'conflict') {
      expect(rB.current).toMatch(/^[0-9a-f]{40}$/);
      expect(rB.retainedCandidate).toMatch(/^[0-9a-f]{40}$/);
      // 候选保留可达：内容仍可读（不删除 loser 分支）
      expect(git(repositoryDir(), 'show', `${rB.retainedCandidate}:eta/SKILL.md`)).toContain('# Eta from B');
    }
    // winner 内容可正常读取；晚到者不覆盖
    expect(await svcA.loadPublished('eta')).toContain('# Eta from A');
    // 同 operationId 重放同一冲突结果
    const replay = await svcB.importSkill({ name: 'eta', source: srcB, operationId: 'imp-eta-B', basis });
    expect(replay).toEqual(rB);
  });
});
