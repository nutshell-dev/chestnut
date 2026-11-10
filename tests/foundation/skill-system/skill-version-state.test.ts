/**
 * Phase 1921 Step C：SkillVersions 多实例索引一致性（真实 Git）。
 *
 * 验收（z-read-probe 复现的缺陷）：
 * - 两个实例交错发布不同技能后 state、projection、format summary 都含完整集合
 *   （旧 writeState 整文件覆盖会丢一方）；
 * - 技能集合从 published tree 派生：任一实例可读他方发布后发布的技能，
 *   重启/投影删除后重建完整；
 * - 并发编辑（edit 事务路径）后索引完整；
 * - 崩溃残留 state.lock（死 holder）被接管，不饿死。
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
} from '../../../src/foundation/skill-system/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const SKILL_MD = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`;
const basis: SkillBasis = { actor: 'test-agent', reason: 'multi-instance index test', sourceRefs: ['ref-1'] };
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

describe.skipIf(!gitAvailable)('SkillVersions 多实例索引一致性（Phase 1921 Step C）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-state-');
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
    fsFactory?: (baseDir: string) => FileSystem;
  }): Promise<SkillVersions> {
    fsSync.mkdirSync(repositoryDir(), { recursive: true });
    return createSkillVersions({
      repositoryDir: repositoryDir(),
      workspaceParent: workspaceParent(),
      stateDir: stateDir(),
      fsFactory: opts?.fsFactory ?? fsFactory,
      audit: makeAudit().audit,
    });
  }

  /** 基线技能 alpha（SKILL.md）；在首次服务启动前播种 */
  function seedBaseline(): void {
    const alpha = path.join(repositoryDir(), 'alpha');
    fsSync.mkdirSync(alpha, { recursive: true });
    fsSync.writeFileSync(path.join(alpha, 'SKILL.md'), SKILL_MD('alpha', '# Alpha orig\n'));
  }

  /** import 用源目录（独立目录，非库内路径） */
  function skillSrc(name: string, body: string): string {
    const src = path.join(tmpDir, `src-${name}`);
    fsSync.mkdirSync(src, { recursive: true });
    fsSync.writeFileSync(path.join(src, 'SKILL.md'), SKILL_MD(name, body));
    return src;
  }

  function readStateSkills(): string[] {
    const state = JSON.parse(fsSync.readFileSync(path.join(stateDir(), 'state.json'), 'utf-8'));
    return state.skills as string[];
  }

  function writeWsFile(handle: SkillEditHandle, rel: string, content: string): void {
    const abs = path.join(handle.path, rel);
    fsSync.mkdirSync(path.dirname(abs), { recursive: true });
    fsSync.writeFileSync(abs, content);
  }

  function readImportRecord(operationId: string) {
    const importsDir = path.join(stateDir(), 'imports');
    const records = fsSync.readdirSync(importsDir).map(file => JSON.parse(
      fsSync.readFileSync(path.join(importsDir, file), 'utf-8'),
    ) as { operationId: string; status: string; result?: unknown });
    return records.find(record => record.operationId === operationId);
  }

  it('两个实例交错发布不同技能：state / projection / summary 含完整集合', async () => {
    seedBaseline();
    const svcA = await makeService();
    const svcB = await makeService();

    // 并发发布 beta/gamma（Git CAS 串行化 publish，但 state 更新在各自实例内存上进行）
    const [r1, r2] = await Promise.all([
      svcA.importSkill({ name: 'beta', source: skillSrc('beta', '# Beta v1\n'), operationId: 'imp-beta', basis }),
      svcB.importSkill({ name: 'gamma', source: skillSrc('gamma', '# Gamma v1\n'), operationId: 'imp-gamma', basis }),
    ]);
    expect(r1.kind).toBe('published');
    expect(r2.kind).toBe('published');

    // state 清单完整（锁内并集合并，互不覆盖）
    expect(readStateSkills()).toEqual(['alpha', 'beta', 'gamma']);

    // 索引从 published tree 派生：旧实例立即读得到对方发布的技能
    expect(await svcA.loadPublished('gamma')).toContain('# Gamma v1');
    expect(await svcB.loadPublished('beta')).toContain('# Beta v1');

    const summary = await svcA.formatPublishedForContext();
    expect(summary).toContain('alpha');
    expect(summary).toContain('beta');
    expect(summary).toContain('gamma');

    // 重启视角（新实例）同样完整
    const svcC = await makeService();
    expect(await svcC.loadPublished('beta')).toContain('# Beta v1');
    expect(await svcC.loadPublished('gamma')).toContain('# Gamma v1');
  });

  it('重启 + 投影目录删除：从 published tree 重建完整集合', async () => {
    seedBaseline();
    const svcA = await makeService();
    const r = await svcA.importSkill({ name: 'beta', source: skillSrc('beta', '# Beta v1\n'), operationId: 'imp-beta', basis });
    expect(r.kind).toBe('published');

    // 投影整体丢失（崩溃/清理窗口）
    fsSync.rmSync(path.join(stateDir(), 'projection'), { recursive: true, force: true });
    fsSync.rmSync(path.join(stateDir(), 'projection-manifest.json'), { force: true });

    const svcB = await makeService();
    expect(await svcB.loadPublished('alpha')).toContain('# Alpha orig');
    expect(await svcB.loadPublished('beta')).toContain('# Beta v1');
    const summary = await svcB.formatPublishedForContext();
    expect(summary).toContain('alpha');
    expect(summary).toContain('beta');
  });

  it('两个实例并发编辑不同技能：edit 发布路径索引同样完整', async () => {
    seedBaseline();
    const svcA = await makeService();
    const svcB = await makeService();

    const h1 = await svcA.beginEdit({ skillName: 'alpha', requestId: 'edit-alpha-1', basis });
    const h2 = await svcB.beginEdit({ skillName: 'beta', requestId: 'edit-beta-1', basis });
    writeWsFile(h1, 'SKILL.md', SKILL_MD('alpha', '# Alpha v2\n'));
    writeWsFile(h2, 'SKILL.md', SKILL_MD('beta', '# Beta v2\n'));

    const [s1, s2] = await Promise.all([svcA.submitEdit(h1.editId), svcB.submitEdit(h2.editId)]);
    expect(s1.kind).toBe('published');
    expect(s2.kind).toBe('published');

    expect(readStateSkills()).toEqual(['alpha', 'beta']);
    // 交叉读取：各自看到对方发布的新版本
    expect(await svcA.loadPublished('beta')).toContain('# Beta v2');
    expect(await svcB.loadPublished('alpha')).toContain('# Alpha v2');
  });

  for (const restart of [false, true]) {
    it(`import 发布后 state.lock 写入失败：${restart ? '重启' : '同实例'}重试恢复索引且不重发`, async () => {
      seedBaseline();
      let armed = false;
      const injected = Object.assign(new Error('injected state.lock acquisition failure'), { code: 'EIO' });
      const failingFsFactory = (baseDir: string): FileSystem => {
        const backend = new NodeFileSystem({ baseDir });
        return new Proxy(backend, {
          get(target, key) {
            if (key === 'writeExclusive') {
              return async (rel: string, content: string) => {
                if (armed && baseDir === stateDir() && rel === 'state.lock') {
                  armed = false;
                  throw injected;
                }
                return target.writeExclusive(rel, content);
              };
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
      const svc1 = await makeService({ fsFactory: failingFsFactory });
      const input = {
        name: 'beta',
        source: skillSrc('beta', '# Beta recovered\n'),
        operationId: 'imp-state-recovery',
        basis,
      };

      // baseline 已完成；仅让发布后的首次 state.lock 获取失败。
      armed = true;
      await expect(svc1.importSkill(input)).rejects.toBe(injected);
      expect(armed).toBe(false);
      const publishedHead = git(repositoryDir(), 'rev-parse', 'refs/version/published');
      const published = await svc1.readPublished('beta');
      expect(published.sourceVersion).toMatch(/^[0-9a-f]{40}$/);
      expect(readStateSkills()).toEqual(['alpha']);
      expect(readImportRecord(input.operationId)).toMatchObject({ status: 'prepared' });

      const svc2 = restart ? await makeService() : svc1;
      const retry = await svc2.importSkill(input);
      expect(retry).toEqual({ kind: 'published', version: published.sourceVersion });
      expect(readStateSkills()).toEqual(['alpha', 'beta']);
      expect(readImportRecord(input.operationId)).toMatchObject({
        status: 'completed',
        result: { kind: 'published', version: published.sourceVersion },
      });
      expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(publishedHead);
    });
  }

  for (const restart of [false, true]) {
    it(`import 发布后观测证据写失败：${restart ? '重启' : '同实例'}重试补写 state 且不重发`, async () => {
      seedBaseline();
      let armed = false;
      const injected = new Error('injected state lock evidence failure');
      const failingFsFactory = (baseDir: string): FileSystem => {
        const backend = new NodeFileSystem({ baseDir });
        return new Proxy(backend, {
          get(target, key) {
            if (key === 'writeAtomicSync') {
              return (rel: string, content: string) => {
                if (armed && baseDir === stateDir() && rel.startsWith('state-lock-observations/')
                    && content.includes('"event":"holder_decision"')) {
                  armed = false;
                  throw injected;
                }
                return target.writeAtomicSync(rel, content);
              };
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
      const svc1 = await makeService({ fsFactory: failingFsFactory });
      fsSync.writeFileSync(
        path.join(stateDir(), 'state.lock'),
        JSON.stringify({ pid: 99999999, at: Date.now() }),
      );
      const input = {
        name: 'beta',
        source: skillSrc('beta', '# Beta evidence recovery\n'),
        operationId: 'imp-evidence-recovery',
        basis,
      };

      armed = true;
      await expect(svc1.importSkill(input)).rejects.toMatchObject({
        kind: 'store_error',
        cause: { pendingRecord: { event: 'holder_decision' }, error: injected },
      });
      expect(armed).toBe(false);
      const publishedHead = git(repositoryDir(), 'rev-parse', 'refs/version/published');
      const published = await svc1.readPublished('beta');
      expect(readStateSkills()).toEqual(['alpha']);
      expect(readImportRecord(input.operationId)).toMatchObject({ status: 'prepared' });

      const svc2 = restart ? await makeService() : svc1;
      const retry = await svc2.importSkill(input);
      expect(retry).toEqual({ kind: 'published', version: published.sourceVersion });
      expect(readStateSkills()).toEqual(['alpha', 'beta']);
      expect(readImportRecord(input.operationId)).toMatchObject({
        status: 'completed',
        result: { kind: 'published', version: published.sourceVersion },
      });
      expect(git(repositoryDir(), 'rev-parse', 'refs/version/published')).toBe(publishedHead);
      expect(await svc2.loadPublished('beta')).toContain('# Beta evidence recovery');
    });
  }

  it('崩溃残留 state.lock（死 holder）被接管，发布不饿死', async () => {
    seedBaseline();
    const svcA = await makeService();

    // 崩溃现场：锁文件遗留、holder pid 已死
    fsSync.writeFileSync(
      path.join(stateDir(), 'state.lock'),
      JSON.stringify({ pid: 99999999, at: Date.now() }),
    );

    const r = await svcA.importSkill({ name: 'beta', source: skillSrc('beta', '# Beta v1\n'), operationId: 'imp-beta', basis });
    expect(r.kind).toBe('published');
    expect(readStateSkills()).toEqual(['alpha', 'beta']);
    // 临界区结束锁已释放
    expect(fsSync.existsSync(path.join(stateDir(), 'state.lock'))).toBe(false);
  });
});
