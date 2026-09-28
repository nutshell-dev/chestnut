/**
 * Phase 1919 Step F — 安装来源版本固定（sourceVersion pinning）
 *
 * 验收：
 * - claw 安装选版点 = 命令 begin 读 published；sourceVersion 随 durable intent
 *   （schema 3）先于第一次复制持久化，成功安装 audit 记录来源 commit；
 * - 反向三项：
 *   1. 进行中的安装不混入并发新发布（快照在场复用 / 导出前崩溃重导出）；
 *   2. 重启后快照缺失按固定 commit 重建，仍旧版、不回读 live；
 *   3. 固定 commit 缺失/损坏 fail-closed，不回退 live、claim 留证；
 * - 旧 schema-2 intent（无 sourceVersion）保持原 manifest 校验恢复，
 *   不给旧字节追认当前 commit。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { skillInstallUserCommand, skillInstallClawCommand } from '../../src/cli/commands/skill.js';
import { SKILL_COMMIT_PROOF, createSkillVersions } from '../../src/foundation/skill-system/index.js';
import { sha256Hex } from '../../src/foundation/node-utils/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { makeAudit } from '../helpers/audit.js';

let testDir: string;
let originalRoot: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  testDir = path.join(os.tmpdir(), `.test-skill-install-version-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  fs.mkdirSync(testDir, { recursive: true });
  originalRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = testDir;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.restoreAllMocks();
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  fs.rmSync(testDir, { recursive: true, force: true });
});

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const deps = { fsFactory };

function makeSkillSource(parent: string, version: string): string {
  const src = path.join(testDir, parent, 'myskill');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), `# myskill ${version}\n`);
  fs.writeFileSync(path.join(src, 'run.sh'), `echo ${version}\n`);
  return src;
}

function makeClaw(id: string): void {
  fs.mkdirSync(path.join(testDir, '.chestnut', 'claws', id), { recursive: true });
}
function clawSkillDir(id: string): string {
  return path.join(testDir, '.chestnut', 'claws', id, 'skills', 'myskill');
}
function clawSkillsParent(id: string): string {
  return path.join(testDir, '.chestnut', 'claws', id, 'skills');
}
function clawClaimPath(id: string): string {
  return path.join(clawSkillsParent(id), '.myskill.installing');
}
function killHolder(claimFile: string): void {
  const claim = JSON.parse(fs.readFileSync(claimFile, 'utf-8'));
  claim.pid = 99999;
  delete claim.process_start_time;
  fs.writeFileSync(claimFile, JSON.stringify(claim, null, 2));
}

/** dispatch 版本服务（测试视角只读/发布入口，与 CLI 装配同路径）。 */
async function dispatchVersions() {
  const clawspace = path.join(testDir, '.chestnut', 'motion', 'clawspace');
  return createSkillVersions({
    repositoryDir: path.join(clawspace, 'dispatch-skills'),
    workspaceParent: path.join(clawspace, '.dispatch-workspaces'),
    stateDir: path.join(clawspace, '.dispatch-version-state'),
    fsFactory,
    audit: makeAudit().audit,
  });
}

/** 经 user install 把 src 发布进 dispatch 版本库（owner import 通道）。 */
async function publishDispatch(srcParent: string, version: string): Promise<void> {
  await skillInstallUserCommand(deps, makeSkillSource(srcParent, version));
}

/** 与生产 computeSkillSourceManifest 同构造的目录内容清单（fixture 用）。 */
function manifestOf(dirAbs: string): { path: string; size: number; sha256: string }[] {
  const out: { path: string; size: number; sha256: string }[] = [];
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(dirAbs, rel))) {
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = fs.statSync(path.join(dirAbs, r));
      if (st.isDirectory()) { walk(r); continue; }
      if (r === SKILL_COMMIT_PROOF) continue; // 协议工件非 payload（与生产一致）
      const content = fs.readFileSync(path.join(dirAbs, r));
      out.push({ path: r, size: content.length, sha256: sha256Hex(content.toString('utf-8')) });
    }
  };
  walk('');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

describe('Phase 1919 Step F: 安装来源版本固定（sourceVersion pinning）', () => {
  it('fresh 安装固定 begin 选定的 commit，成功 audit 记录来源 commit', async () => {
    await publishDispatch('a', 'v1');
    const v1 = (await (await dispatchVersions()).readPublished('myskill')).sourceVersion;
    makeClaw('bob');
    const { audit, events } = makeAudit();

    await skillInstallClawCommand(deps, 'bob', 'myskill', { audit });

    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'SKILL.md'), 'utf-8')).toBe('# myskill v1\n');
    const installEvents = events.filter((e) => e[0] === 'cli_skill_install');
    expect(installEvents.length).toBe(1);
    expect(installEvents[0]).toContain(`source_version=${v1}`);
    // 成功后无 claim/快照残留
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(false);
    expect(fs.readdirSync(clawSkillsParent('bob')).filter((n) => n.startsWith('.skill-'))).toEqual([]);
  });

  it('并发新发布不改变本次来源：begin 选定 v1 后 dispatch 发布 v2，安装仍是 v1', async () => {
    await publishDispatch('a', 'v1');
    const versions = await dispatchVersions();
    const v1 = (await versions.readPublished('myskill')).sourceVersion;
    makeClaw('bob');

    // 在导出固定 commit 的窗口内并发发布 v2（导出参数必须仍是 begin 选定的 v1）
    let publishedV2 = false;
    const exportedVersions: string[] = [];
    const racingFactory: typeof createSkillVersions = async (opts) => {
      const real = await createSkillVersions(opts);
      return {
        readPublished: real.readPublished.bind(real),
        loadPublished: real.loadPublished.bind(real),
        formatPublishedForContext: real.formatPublishedForContext.bind(real),
        importSkill: real.importSkill.bind(real),
        beginEdit: real.beginEdit.bind(real),
        submitEdit: real.submitEdit.bind(real),
        retryEdit: real.retryEdit.bind(real),
        cancelEdit: real.cancelEdit.bind(real),
        editStatus: real.editStatus.bind(real),
        editHistory: real.editHistory.bind(real),
        exportSkillVersion: async (input: { name: string; version: string; destination: string }) => {
          exportedVersions.push(input.version);
          if (!publishedV2) {
            publishedV2 = true;
            const srcV2 = makeSkillSource('b', 'v2');
            const result = await real.importSkill({
              name: 'myskill',
              source: srcV2,
              operationId: 'test-concurrent-v2',
              basis: { actor: 'user-install', reason: 'concurrent v2 publish', sourceRefs: [srcV2] },
            });
            expect(result.kind).toBe('published');
          }
          return real.exportSkillVersion(input);
        },
      };
    };

    await skillInstallClawCommand(deps, 'bob', 'myskill', { createSkillVersions: racingFactory });

    // 导出用的就是 begin 选定的 v1 commit；安装结果是 v1 完整字节
    expect(exportedVersions).toEqual([v1]);
    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'SKILL.md'), 'utf-8')).toBe('# myskill v1\n');
    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'run.sh'), 'utf-8')).toBe('echo v1\n');
    // dispatch 已推进到 v2（本次安装不回退、不混入）
    expect(await (await dispatchVersions()).loadPublished('myskill')).toBe('# myskill v2\n');
  });

  it('崩溃于来源导出登记前（manifest 空窗口）→ 恢复按固定 commit 重导出，不混入新发布', async () => {
    await publishDispatch('a', 'v1');
    const v1 = (await (await dispatchVersions()).readPublished('myskill')).sourceVersion;
    makeClaw('bob');

    // 崩溃：claim（含 sourceVersion）已持久化、首次导出失败
    let crashed = false;
    const crashExportFactory: typeof createSkillVersions = async (opts) => {
      const real = await createSkillVersions(opts);
      return {
        readPublished: real.readPublished.bind(real),
        loadPublished: real.loadPublished.bind(real),
        formatPublishedForContext: real.formatPublishedForContext.bind(real),
        importSkill: real.importSkill.bind(real),
        beginEdit: real.beginEdit.bind(real),
        submitEdit: real.submitEdit.bind(real),
        retryEdit: real.retryEdit.bind(real),
        cancelEdit: real.cancelEdit.bind(real),
        editStatus: real.editStatus.bind(real),
        editHistory: real.editHistory.bind(real),
        exportSkillVersion: async (input: { name: string; version: string; destination: string }) => {
          if (!crashed) {
            crashed = true;
            throw new Error('simulated crash at pinned source export');
          }
          return real.exportSkillVersion(input);
        },
      };
    };
    await expect(
      skillInstallClawCommand(deps, 'bob', 'myskill', { createSkillVersions: crashExportFactory }),
    ).rejects.toThrow(/pinned source version .* cannot be exported/);

    // durable intent：pinning 先于第一次复制持久化（schema 3 + sourceVersion，manifest 待补）
    const intent = JSON.parse(fs.readFileSync(clawClaimPath('bob'), 'utf-8'));
    expect(intent.schema_version).toBe(3);
    expect(intent.sourceVersion).toBe(v1);
    expect(intent.manifest).toEqual([]);
    killHolder(clawClaimPath('bob'));

    // 崩溃窗口后 dispatch 发布 v2 → 恢复仍完成固定版本 v1，绝不混入新字节
    await publishDispatch('b', 'v2');
    await skillInstallClawCommand(deps, 'bob', 'myskill');

    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'SKILL.md'), 'utf-8')).toBe('# myskill v1\n');
    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'run.sh'), 'utf-8')).toBe('echo v1\n');
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(false);
  });

  it('重启后快照缺失按固定 commit 重建：仍旧版、不回读 live', async () => {
    await publishDispatch('a', 'v1');
    makeClaw('bob');

    // 崩溃：快照已物化 + manifest 已登记，首个目标 publishing 登记时中断
    const clawDir = path.join(testDir, '.chestnut', 'claws', 'bob');
    let crashed = false;
    const crashFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(clawDir)) {
        const origWrite = real.writeAtomicSync.bind(real);
        real.writeAtomicSync = (p: string, content: string) => {
          if (!crashed && p.endsWith('.myskill.installing') && content.includes('"state": "publishing"')) {
            crashed = true;
            throw new Error('simulated crash before target publish');
          }
          return origWrite(p, content);
        };
      }
      return real;
    };
    await expect(
      skillInstallClawCommand({ fsFactory: crashFactory }, 'bob', 'myskill'),
    ).rejects.toThrow(/simulated crash/);

    // 重启丢失临时快照
    const snapName = fs.readdirSync(clawSkillsParent('bob')).find((n) => n.startsWith('.skill-srcsnap-myskill-'));
    expect(snapName).toBeDefined();
    fs.rmSync(path.join(clawSkillsParent('bob'), snapName as string), { recursive: true, force: true });
    killHolder(clawClaimPath('bob'));

    // dispatch 推进到 v2：恢复按 intent 固定 commit 重建，仍是 v1（不升级到最新）
    await publishDispatch('b', 'v2');
    await skillInstallClawCommand(deps, 'bob', 'myskill');

    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'SKILL.md'), 'utf-8')).toBe('# myskill v1\n');
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(false);
  });

  it('固定 commit 缺失/损坏 → fail-closed 不回退 live，claim 与目标留证', async () => {
    await publishDispatch('a', 'v1');
    const projectionPath = (await (await dispatchVersions()).readPublished('myskill')).materializedPath;
    makeClaw('bob');

    // 手工 fixture：pinned intent 指向版本库中不存在的 commit，快照缺失
    const bogus = '1'.repeat(40);
    const intent = {
      schema_version: 3,
      token: 'tok-bogus',
      id: 'install-bogus',
      skillName: 'myskill',
      source: projectionPath,
      sourceVersion: bogus,
      pid: 99999, // holder 已死
      startedAt: new Date().toISOString(),
      manifest: [],
      sourceSnapshot: '.skill-srcsnap-myskill-tok-bogus',
      targets: [{ id: 'claw', state: 'pending', preState: 'absent' }],
    };
    fs.mkdirSync(clawSkillsParent('bob'), { recursive: true });
    fs.writeFileSync(clawClaimPath('bob'), JSON.stringify(intent, null, 2));

    await expect(skillInstallClawCommand(deps, 'bob', 'myskill')).rejects.toThrow(/fail-closed/);

    // 不回退 live：目标未创建；claim/快照现场保留待显式处置
    expect(fs.existsSync(clawSkillDir('bob'))).toBe(false);
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(true);
    expect(
      fs.readdirSync(clawSkillsParent('bob')).filter((n) => n.startsWith('.skill-srcsnap-')),
    ).toEqual([]);
  });

  it('旧 schema-2 intent（无 sourceVersion）恢复保持 manifest 校验，不追认当前 commit', async () => {
    await publishDispatch('a', 'v1');
    const published = await (await dispatchVersions()).readPublished('myskill');
    const v1Manifest = manifestOf(published.materializedPath);
    makeClaw('bob');

    // 手工 fixture：旧协议中断安装（schema 2，无 sourceVersion，快照缺失）
    const intent = {
      schema_version: 2,
      token: 'tok-legacy',
      id: 'install-legacy',
      skillName: 'myskill',
      source: published.materializedPath,
      pid: 99999,
      startedAt: new Date().toISOString(),
      manifest: v1Manifest,
      targets: [{ id: 'claw', state: 'pending', preState: 'absent' }],
    };
    fs.mkdirSync(clawSkillsParent('bob'), { recursive: true });
    fs.writeFileSync(clawClaimPath('bob'), JSON.stringify(intent, null, 2));

    // live 已推进到 v2 → 旧 intent 的 manifest 校验拒绝追认当前 commit，显式冲突留证
    await publishDispatch('b', 'v2');
    await expect(skillInstallClawCommand(deps, 'bob', 'myskill')).rejects.toThrow(/different source payload/);

    expect(fs.existsSync(clawSkillDir('bob'))).toBe(false);
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(true);
  });
});
