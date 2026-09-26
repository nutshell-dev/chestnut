/**
 * Phase 1911 Step G — skill 多根复制一致提交（RACE-CLI-SKILL-MULTIROOT-COPY）
 *
 * 验收：
 * - user install：root 与 motion dispatch 两目标各自完整发布，无 claim/staging
 *   残留，audit 只在两目标完成后发出；
 * - 并发同名不同版本安装：恰一 winner，loser typed 冲突，目录不混写；
 * - 崩溃窗口：holder 已死 + 同 payload → 自动恢复未完成目标；异 payload →
 *   显式冲突留证不覆盖；
 * - claw install：staging/swap 发布，消费者只见完整版本。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { skillInstallUserCommand, skillInstallClawCommand } from '../../src/cli/commands/skill.js';
import { SkillSystem, SKILL_PUBLISH_MARKER } from '../../src/foundation/skill-system/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';

let testDir: string;
let originalRoot: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  testDir = path.join(os.tmpdir(), `.test-skill-install-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
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

function userSkillDir(): string {
  return path.join(testDir, 'skills', 'myskill');
}
function dispatchSkillDir(): string {
  return path.join(testDir, '.chestnut', 'motion', 'clawspace', 'dispatch-skills', 'myskill');
}
function claimPath(): string {
  return path.join(testDir, 'skills', '.myskill.installing');
}

function readVersion(dir: string): string {
  return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
}

describe('skill install target occupancy (phase 1912 Step D)', () => {
  it('absent 目标并发出现占位：mkdirExclusive 冲突，不替换不混入', async () => {
    const src = makeSkillSource('a', 'vX');
    const userParent = path.dirname(userSkillDir());
    // 占位裁决前外部抢先建空目录 → mkdirExclusiveSync EEXIST → typed 冲突
    const racingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(userParent)) {
        const origMkdir = real.mkdirExclusiveSync.bind(real);
        real.mkdirExclusiveSync = (p: string) => {
          if (p === 'myskill') fs.mkdirSync(path.join(userParent, 'myskill'), { recursive: true });
          return origMkdir(p);
        };
      }
      return real;
    };

    await expect(skillInstallUserCommand({ fsFactory: racingFactory }, src))
      .rejects.toThrow(/appeared concurrently/);

    // 外部空占位原样保留，未混入我们的文件
    expect(fs.readdirSync(userSkillDir())).toEqual([]);
  });

  it('existing 目标让位窗口被外部重建：还原旧版 + 冲突留证', async () => {
    const src = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, src);
    expect(readVersion(userSkillDir())).toBe('# myskill v1\n');

    // 更新安装：旧版 rename 入 trash 后，外部立刻重建空目标目录
    const srcV2 = makeSkillSource('b', 'v2');
    const userParent = path.dirname(userSkillDir());
    let moved = false;
    const racingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(userParent)) {
        const origMoveDir = real.moveDir.bind(real);
        real.moveDir = async (from: string, to: string) => {
          const r = await origMoveDir(from, to);
          if (from === 'myskill' && to.startsWith('.skill-trash-') && !moved) {
            moved = true;
            fs.mkdirSync(path.join(userParent, 'myskill'));
          }
          return r;
        };
      }
      return real;
    };

    await expect(skillInstallUserCommand({ fsFactory: racingFactory }, srcV2))
      .rejects.toThrow(/recreated externally/);

    // 旧版还原，外部空占位被还原替换；内容仍是 v1
    expect(readVersion(userSkillDir())).toBe('# myskill v1\n');
  });
});

describe('skill install multi-root consistent commit (phase 1911 Step G)', () => {
  it('user install：两目标完整发布、无残留、audit 在完成后一次', async () => {
    const src = makeSkillSource('a', 'v1');
    const audit = { write: vi.fn() };

    await skillInstallUserCommand(deps, src, { audit: audit as never });

    expect(readVersion(userSkillDir())).toBe('# myskill v1\n');
    expect(readVersion(dispatchSkillDir())).toBe('# myskill v1\n');
    expect(fs.existsSync(claimPath())).toBe(false);
    for (const parent of [path.dirname(userSkillDir()), path.dirname(dispatchSkillDir())]) {
      expect(fs.readdirSync(parent).filter((n) => n.startsWith('.skill-'))).toEqual([]);
    }
    expect(audit.write).toHaveBeenCalledTimes(1);
    expect(audit.write).toHaveBeenCalledWith('cli_skill_install', 'mode=user', 'skill=myskill');
  });

  it('并发同名不同版本安装：恰一 winner，loser 冲突，目录为单一完整版本', async () => {
    const srcA = makeSkillSource('a', 'vA');
    const srcB = makeSkillSource('b', 'vB');

    const results = await Promise.allSettled([
      skillInstallUserCommand(deps, srcA),
      skillInstallUserCommand(deps, srcB),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(/in progress|claim/i);

    // 两目标都是同一完整版本（不混写）
    const userVersion = readVersion(userSkillDir());
    expect(['# myskill vA\n', '# myskill vB\n']).toContain(userVersion);
    expect(readVersion(dispatchSkillDir())).toBe(userVersion);
    const runSh = fs.readFileSync(path.join(userSkillDir(), 'run.sh'), 'utf-8');
    expect(runSh).toBe(userVersion.includes('vA') ? 'echo vA\n' : 'echo vB\n');
  });

  it('崩溃窗口：holder 已死 + 同 payload → 恢复未完成目标并释放 claim', async () => {
    const src = makeSkillSource('a', 'v1');
    // 模拟崩溃：dispatch 首次 no-replace 落位失败 → claim 残留
    // （user=published，dispatch=pending，占位目录可能已建）
    const dispatchParent = path.dirname(dispatchSkillDir());
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        real.linkExclusiveSync = () => { throw new Error('simulated crash at dispatch publish'); };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    // claim 残留、user 已发布、dispatch 未完成（intent 状态为据）
    expect(fs.existsSync(claimPath())).toBe(true);
    expect(readVersion(userSkillDir())).toBe('# myskill v1\n');
    const crashedIntent = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    expect(crashedIntent.targets).toEqual([
      { id: 'user', state: 'published', preState: 'absent' },
      // Phase 1915 Step B：崩溃发生在 dispatch 发布中途 → publishing（区分
      // 「本 intent 已触碰该目标」与「尚未触碰」）；Phase 1916 Step C：preState
      // 记录崩溃前先态作 recovery 身份证据
      { id: 'dispatch', state: 'publishing', preState: 'absent' },
    ]);

    // 模拟 holder 进程死亡（崩溃后 pid 不复存在）
    const claim = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fs.writeFileSync(claimPath(), JSON.stringify(claim, null, 2));

    await skillInstallUserCommand(deps, src);

    expect(readVersion(dispatchSkillDir())).toBe('# myskill v1\n');
    expect(fs.existsSync(claimPath())).toBe(false);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('resumed');
  });

  it('崩溃窗口：holder 已死 + 异 payload → 显式冲突留证，不覆盖', async () => {
    const srcA = makeSkillSource('a', 'vA');
    const dispatchParent = path.dirname(dispatchSkillDir());
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        real.linkExclusiveSync = () => { throw new Error('simulated crash'); };
      }
      return real;
    };
    await expect(skillInstallUserCommand({ fsFactory: crashingFactory }, srcA)).rejects.toThrow();
    const claim = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    claim.pid = 99999;
    fs.writeFileSync(claimPath(), JSON.stringify(claim, null, 2));

    // 不同版本源重试 → 冲突，claim 证据保留，dispatch 未发布（无 SKILL.md）
    const srcB = makeSkillSource('b', 'vB');
    await expect(skillInstallUserCommand(deps, srcB)).rejects.toThrow(/different source payload/);
    expect(fs.existsSync(claimPath())).toBe(true);
    expect(fs.existsSync(path.join(dispatchSkillDir(), 'SKILL.md'))).toBe(false);
    expect(readVersion(userSkillDir())).toBe('# myskill vA\n');
  });

  it('claw install：staged swap 发布完整版本；更新整体替换', async () => {
    // 先准备 dispatch 源（经 user install 协议产出）
    const src = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, src);

    const clawDir = path.join(testDir, '.chestnut', 'claws', 'bob');
    fs.mkdirSync(clawDir, { recursive: true });
    await skillInstallClawCommand(deps, 'bob', 'myskill');

    const clawSkill = path.join(clawDir, 'skills', 'myskill');
    expect(readVersion(clawSkill)).toBe('# myskill v1\n');
    expect(fs.existsSync(path.join(clawDir, 'skills', '.myskill.installing'))).toBe(false);

    // 更新：dispatch 源升级后重装 → 整体替换为完整新版
    fs.writeFileSync(path.join(dispatchSkillDir(), 'SKILL.md'), '# myskill v2\n');
    await skillInstallClawCommand(deps, 'bob', 'myskill');
    expect(readVersion(clawSkill)).toBe('# myskill v2\n');
    expect(fs.existsSync(path.join(clawSkill, 'run.sh'))).toBe(true); // 旧版文件随新版保留（同源快照）
  });
});


describe('skill 提交前可见性门控（Phase 1913 Step C：RACE-PUBLISH-PRECOMMIT-VISIBILITY）', () => {
  it('SKILL.md 先落位、引用文件未落位的崩溃窗口：SkillSystem 不注册半版本；恢复后注册完整版本', async () => {
    // manifest 按 localeCompare 排序：'SKILL.md' < 'zzz.sh'，SKILL.md 先落位
    const src = path.join(testDir, 'a', 'myskill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '# myskill v1\n');
    fs.writeFileSync(path.join(src, 'zzz.sh'), 'echo v1\n');
    const dispatchParent = path.dirname(dispatchSkillDir());

    // 模拟崩溃：SKILL.md 落位后，第二文件 link 失败 —— 目标目录含
    // SKILL.md + marker，属半版本
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        const origLink = real.linkExclusiveSync.bind(real);
        real.linkExclusiveSync = (from: string, to: string) => {
          if (to === 'myskill/zzz.sh') throw new Error('simulated crash mid-landing');
          return origLink(from, to);
        };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    // 半版本证据：SKILL.md 已落位 + 引用文件未落位 + marker 在（= 未提交）
    expect(fs.existsSync(path.join(dispatchSkillDir(), 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dispatchSkillDir(), 'zzz.sh'))).toBe(false);
    expect(fs.existsSync(path.join(dispatchSkillDir(), '.skill-publishing'))).toBe(true);

    // SkillSystem 读侧：不注册半版本 + audit 留证
    const auditCalls: string[][] = [];
    const registry = new SkillSystem(
      new NodeFileSystem({ baseDir: testDir }),
      path.relative(testDir, dispatchParent),
      { write: (...args: string[]) => { auditCalls.push(args); } } as never,
    );
    await registry.loadAll();
    expect(registry.listMeta()).toEqual([]);
    expect(auditCalls.some(c => c[0] === 'skill_publish_in_progress_skipped')).toBe(true);

    // 死 holder 同 payload 恢复 → 提交 → registry 注册完整版本
    const claim = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fs.writeFileSync(claimPath(), JSON.stringify(claim, null, 2));
    await skillInstallUserCommand(deps, src);

    expect(fs.existsSync(path.join(dispatchSkillDir(), '.skill-publishing'))).toBe(false);
    expect(fs.readFileSync(path.join(dispatchSkillDir(), 'zzz.sh'), 'utf-8')).toBe('echo v1\n');
    await registry.loadAll();
    expect(registry.listMeta().map(m => m.name)).toEqual(['myskill']);
  });

  it('staging 目录（含完整 SKILL.md 副本）不被 registry 注册', async () => {
    const src = makeSkillSource('a', 'v1');
    const userParent = path.dirname(userSkillDir());
    await skillInstallUserCommand(deps, src);

    // 构造证据形态：staging 目录含完整副本（registry 只认非隐藏目录）
    const staging = path.join(userParent, '.skill-staging-test');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'SKILL.md'), '# myskill v9\n');

    const registry = new SkillSystem(
      new NodeFileSystem({ baseDir: testDir }),
      path.relative(testDir, userParent),
      { write: () => {} } as never,
    );
    await registry.loadAll();
    // 只有正式目标注册；staging 不注册、不触发 duplicate
    expect(registry.listMeta().map(m => m.name)).toEqual(['myskill']);
  });
});


describe('skill target-local 独立提交与恢复（Phase 1915 Step B：RACE-SKILL-TARGET-PRECOMMIT）', () => {
  it('恢复不覆盖已提交后被用户编辑的目标（publishing + marker 缺席 → 只补登记）', async () => {
    const src = makeSkillSource('a', 'v2');
    // 模拟崩溃窗口：user 目标删 marker 提交完成、但 intent 登记 published 前崩溃
    // —— 对 claim 的首个「含 published 状态」写入抛错
    const crashFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(testDir)) {
        const origWrite = real.writeAtomicSync.bind(real);
        real.writeAtomicSync = (p: string, content: string) => {
          if (p.endsWith('.myskill.installing') && content.includes('"state": "published"')) {
            throw new Error('simulated crash after user target commit');
          }
          return origWrite(p, content);
        };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    // 崩溃现场：user 目标已完整提交（committing 登记后删 marker、published
    // 登记前崩溃 → marker 缺席），intent 仍登记 committing
    expect(readVersion(userSkillDir())).toBe('# myskill v2\n');
    expect(fs.existsSync(path.join(userSkillDir(), '.skill-publishing'))).toBe(false);
    const crashedIntent = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    expect(crashedIntent.targets).toEqual([
      { id: 'user', state: 'committing', preState: 'absent', commitBranch: 'absent' },
      { id: 'dispatch', state: 'pending', preState: 'absent' },
    ]);

    // 用户合法 post-install 编辑 self 副本
    fs.writeFileSync(path.join(userSkillDir(), 'SKILL.md'), '# myskill USER-EDITED\n');

    // holder 死亡后恢复
    const claim = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fs.writeFileSync(claimPath(), JSON.stringify(claim, null, 2));

    await skillInstallUserCommand(deps, src);

    // self 副本的用户编辑不被恢复覆盖；dispatch 按 source 补齐；claim 释放
    expect(readVersion(userSkillDir())).toBe('# myskill USER-EDITED\n');
    expect(readVersion(dispatchSkillDir())).toBe('# myskill v2\n');
    expect(fs.existsSync(claimPath())).toBe(false);
  });

  it('self 已提交即可被自身 registry 独立消费，即使 dispatch 仍 pending', async () => {
    const src = makeSkillSource('a', 'v1');
    // 崩溃：dispatch 首次落位失败 → user 已提交、dispatch 未提交（marker 在）
    const dispatchParent = path.dirname(dispatchSkillDir());
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        real.linkExclusiveSync = () => { throw new Error('simulated crash at dispatch publish'); };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    // target-local：dispatch 未提交不影响 self 副本的消费
    const userRegistry = new SkillSystem(
      new NodeFileSystem({ baseDir: testDir }),
      'skills',
      { write: () => {} } as never,
    );
    await userRegistry.loadAll();
    expect(userRegistry.listMeta().map((m) => m.name)).toEqual(['myskill']);

    // dispatch 侧仍门控（marker 在 = 未提交）
    const dispatchRegistry = new SkillSystem(
      new NodeFileSystem({ baseDir: testDir }),
      path.relative(testDir, dispatchParent),
      { write: () => {} } as never,
    );
    await dispatchRegistry.loadAll();
    expect(dispatchRegistry.listMeta()).toEqual([]);

    // 死 holder 恢复后 dispatch 独立补齐
    const claim = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fs.writeFileSync(claimPath(), JSON.stringify(claim, null, 2));
    await skillInstallUserCommand(deps, src);
    expect(readVersion(dispatchSkillDir())).toBe('# myskill v1\n');
  });
});


describe('dispatch source snapshot（Phase 1915 Step C：RACE-DISPATCH-SOURCE-SNAPSHOT）', () => {
  function makeClaw(id: string): void {
    fs.mkdirSync(path.join(testDir, '.chestnut', 'claws', id), { recursive: true });
  }
  function clawSkillDir(id: string): string {
    return path.join(testDir, '.chestnut', 'claws', id, 'skills', 'myskill');
  }
  function clawClaimPath(id: string): string {
    return path.join(testDir, '.chestnut', 'claws', id, 'skills', '.myskill.installing');
  }
  function killHolder(claimFile: string): void {
    const claim = JSON.parse(fs.readFileSync(claimFile, 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fs.writeFileSync(claimFile, JSON.stringify(claim, null, 2));
  }
  /** claw 首次落位崩溃 → claim + 持久快照 + 半落位目标（marker 在）残留。 */
  function clawCrashFactory(clawSkills: string): (baseDir: string) => FileSystem {
    return (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(clawSkills)) {
        real.linkExclusiveSync = () => { throw new Error('simulated crash at claw publish'); };
      }
      return real;
    };
  }

  it('Motion 在快照期间交错编辑 SKILL.md 与引用文件 → 重试收敛，claw 得到一致完整版本', async () => {
    const src = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, src);
    makeClaw('bob');

    const dispatchDir = dispatchSkillDir();
    let mutated = false;
    const racingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchDir)) {
        const origRead = real.read.bind(real);
        real.read = async (p: string) => {
          const content = await origRead(p);
          // 快照复制读到 SKILL.md（v1）后，Motion 交错升级 dispatch 两个文件
          if (p === 'SKILL.md' && !mutated) {
            mutated = true;
            fs.writeFileSync(path.join(dispatchDir, 'SKILL.md'), '# myskill v2\n');
            fs.writeFileSync(path.join(dispatchDir, 'run.sh'), 'echo v2\n');
          }
          return content;
        };
      }
      return real;
    };

    await skillInstallClawCommand({ fsFactory: racingFactory }, 'bob', 'myskill');

    // 快照自一致复核迫使重试 → claw 得到一致的 v2（绝不 SKILL.md v1 + run.sh v2 混合）
    expect(readVersion(clawSkillDir('bob'))).toBe('# myskill v2\n');
    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'run.sh'), 'utf-8')).toBe('echo v2\n');
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(false);
    // 快照目录随成功发布清理
    expect(
      fs.readdirSync(path.dirname(clawSkillDir('bob'))).filter((n) => n.startsWith('.skill-')),
    ).toEqual([]);
  });

  it('source 持续变化 → 有界重试后 fail-closed typed，不发布不留垃圾', async () => {
    const src = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, src);
    makeClaw('bob');

    const dispatchDir = dispatchSkillDir();
    let n = 0;
    const churnFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchDir)) {
        const origRead = real.read.bind(real);
        real.read = async (p: string) => {
          const content = await origRead(p);
          if (p === 'SKILL.md') {
            n++;
            fs.writeFileSync(path.join(dispatchDir, 'SKILL.md'), `# myskill churn-${n}\n`);
          }
          return content;
        };
      }
      return real;
    };

    await expect(
      skillInstallClawCommand({ fsFactory: churnFactory }, 'bob', 'myskill'),
    ).rejects.toThrow(/kept changing/);

    // 快照先于 claim：未拍成一致快照 → 无 claim、无目标、无快照残留
    expect(fs.existsSync(clawSkillDir('bob'))).toBe(false);
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(false);
    expect(
      fs.readdirSync(path.dirname(clawSkillDir('bob'))).filter((x) => x.startsWith('.skill-')),
    ).toEqual([]);
  });

  it('崩溃恢复复用持久快照：dispatch 事后被编辑，恢复仍完成编辑前一致版本；显式重装才升级', async () => {
    const src = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, src);
    makeClaw('bob');

    const clawSkills = path.dirname(clawSkillDir('bob'));
    await expect(
      skillInstallClawCommand({ fsFactory: clawCrashFactory(clawSkills) }, 'bob', 'myskill'),
    ).rejects.toThrow(/simulated crash/);
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(true);

    // Motion 合法编辑 dispatch pool 升级到 v2
    fs.writeFileSync(path.join(dispatchSkillDir(), 'SKILL.md'), '# myskill v2\n');
    fs.writeFileSync(path.join(dispatchSkillDir(), 'run.sh'), 'echo v2\n');

    killHolder(clawClaimPath('bob'));
    await skillInstallClawCommand(deps, 'bob', 'myskill');

    // 恢复完成的是快照锁定的编辑前完整版本（v1 一致），不混入 v2 字节
    expect(readVersion(clawSkillDir('bob'))).toBe('# myskill v1\n');
    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'run.sh'), 'utf-8')).toBe('echo v1\n');
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(false);

    // 显式重装 = update 语义 → 升级到当前 dispatch 版本
    await skillInstallClawCommand(deps, 'bob', 'myskill');
    expect(readVersion(clawSkillDir('bob'))).toBe('# myskill v2\n');
    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'run.sh'), 'utf-8')).toBe('echo v2\n');
  });

  it('快照证据丢失 + source generation 变化 → 显式冲突留证，不发布不覆盖', async () => {
    const src = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, src);
    makeClaw('bob');

    const clawSkills = path.dirname(clawSkillDir('bob'));
    await expect(
      skillInstallClawCommand({ fsFactory: clawCrashFactory(clawSkills) }, 'bob', 'myskill'),
    ).rejects.toThrow(/simulated crash/);

    // 快照证据丢失 + dispatch 升级（source generation 变化）
    for (const n of fs.readdirSync(clawSkills).filter((x) => x.startsWith('.skill-srcsnap-'))) {
      fs.rmSync(path.join(clawSkills, n), { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(dispatchSkillDir(), 'SKILL.md'), '# myskill v2\n');

    killHolder(clawClaimPath('bob'));
    await expect(
      skillInstallClawCommand(deps, 'bob', 'myskill'),
    ).rejects.toThrow(/different source payload/);

    // 证据保留：claim + 半落位目标（marker 仍在，未提交不可消费）
    expect(fs.existsSync(clawClaimPath('bob'))).toBe(true);
    expect(fs.existsSync(path.join(clawSkillDir('bob'), '.skill-publishing'))).toBe(true);
  });
});


describe('dispatch source 协议工件边界（Phase 1916 Step B：RACE-DISPATCH-SOURCE-PROTOCOL-ARTIFACT）', () => {
  function makeClaw(id: string): void {
    fs.mkdirSync(path.join(testDir, '.chestnut', 'claws', id), { recursive: true });
  }
  function clawSkillDir(id: string): string {
    return path.join(testDir, '.chestnut', 'claws', id, 'skills', 'myskill');
  }
  function clawSkillsParent(id: string): string {
    return path.dirname(clawSkillDir(id));
  }

  it('source 发布未提交（marker 持续在场）→ typed mid-publish 失败，snapshot/target 零污染', async () => {
    const src = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, src);
    makeClaw('bob');

    // dispatch source 正处于初次发布窗口（marker 在 = 未提交）
    fs.writeFileSync(path.join(dispatchSkillDir(), SKILL_PUBLISH_MARKER), JSON.stringify({ source: 'x' }));

    await expect(
      skillInstallClawCommand(deps, 'bob', 'myskill'),
    ).rejects.toThrow(/mid-publish/);

    // marker 未被复制成技能 payload：无目标、无 claim、无残留快照
    expect(fs.existsSync(clawSkillDir('bob'))).toBe(false);
    expect(fs.existsSync(path.join(clawSkillsParent('bob'), '.myskill.installing'))).toBe(false);
    expect(
      fs.readdirSync(clawSkillsParent('bob')).filter((n) => n.startsWith('.skill-')),
    ).toEqual([]);
    // source marker 证据原样保留（不由 consumer 删除）
    expect(fs.existsSync(path.join(dispatchSkillDir(), SKILL_PUBLISH_MARKER))).toBe(true);
  });

  it('复制窗口内 marker 出现（交错 publish）→ 本趟快照丢弃重试；marker 消失后收敛，payload 完整无 marker', async () => {
    const src = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, src);
    makeClaw('bob');

    const dispatchDir = dispatchSkillDir();
    const markerAbs = path.join(dispatchDir, SKILL_PUBLISH_MARKER);
    let markerProbes = 0;
    const racingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchDir)) {
        const origRead = real.read.bind(real);
        real.read = async (p: string) => {
          const content = await origRead(p);
          // 快照复制读到 SKILL.md 后，source 进入新一轮发布（marker 落位）
          if (p === 'SKILL.md' && markerProbes >= 0 && !fs.existsSync(markerAbs) && markerProbes < 2) {
            fs.writeFileSync(markerAbs, JSON.stringify({ source: 'race' }));
          }
          return content;
        };
        const origStatSync = real.statSync.bind(real);
        real.statSync = (p: string) => {
          if (p === SKILL_PUBLISH_MARKER) {
            markerProbes++;
            // 第三次探测（第二趟 pre-check）前发布完成：marker 删除
            if (markerProbes >= 3) fs.rmSync(markerAbs, { force: true });
          }
          return origStatSync(p);
        };
      }
      return real;
    };

    await skillInstallClawCommand({ fsFactory: racingFactory }, 'bob', 'myskill');

    // 收敛后 claw 得到完整 payload，marker 不作为技能内容传播
    expect(readVersion(clawSkillDir('bob'))).toBe('# myskill v1\n');
    expect(fs.readFileSync(path.join(clawSkillDir('bob'), 'run.sh'), 'utf-8')).toBe('echo v1\n');
    expect(fs.existsSync(path.join(clawSkillDir('bob'), SKILL_PUBLISH_MARKER))).toBe(false);
    expect(markerProbes).toBeGreaterThanOrEqual(3); // 确实经历了重试
  });

  it('稳定 source 的用户合法隐藏文件（非协议保留名）照常进入 payload', async () => {
    const src = makeSkillSource('a', 'v1');
    // 用户 payload 中的普通隐藏文件（非 owner 保留名）不得被宽泛过滤吞掉
    fs.writeFileSync(path.join(src, '.env-example'), 'KEY=\n');
    await skillInstallUserCommand(deps, src);
    makeClaw('bob');

    await skillInstallClawCommand(deps, 'bob', 'myskill');

    expect(fs.readFileSync(path.join(clawSkillDir('bob'), '.env-example'), 'utf-8')).toBe('KEY=\n');
    expect(fs.existsSync(path.join(clawSkillDir('bob'), SKILL_PUBLISH_MARKER))).toBe(false);
  });
});


describe('target recovery 占有证据（Phase 1916 Step C：RACE-SKILL-RECOVERY-TARGET-IDENTITY）', () => {
  function killHolder(claimFile: string): void {
    const claim = JSON.parse(fs.readFileSync(claimFile, 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fs.writeFileSync(claimFile, JSON.stringify(claim, null, 2));
  }
  /** claim 写入后、首个目标 publishing 登记时崩溃 → 所有 target 仍 pending。 */
  function crashBeforeTargetsFactory(): (baseDir: string) => FileSystem {
    let crashed = false;
    return (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(testDir)) {
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
  }

  it('pending target 崩溃后被外部新建空目录 → typed 冲突留证，外部目录原样保留', async () => {
    const src = makeSkillSource('a', 'v1');
    await expect(
      skillInstallUserCommand({ fsFactory: crashBeforeTargetsFactory() }, src),
    ).rejects.toThrow(/simulated crash/);

    // 崩溃窗口后外部新建空目录（非本 intent 占有）
    fs.mkdirSync(userSkillDir(), { recursive: true });
    killHolder(claimPath());

    await expect(skillInstallUserCommand(deps, src)).rejects.toThrow(/identity cannot be proven/);

    // 外部目录字节不变；claim/intent 证据保留
    expect(fs.readdirSync(userSkillDir())).toEqual([]);
    expect(fs.existsSync(claimPath())).toBe(true);
  });

  it('pending target（合法 update 目标）崩溃后被外部编辑 → 冲突不覆盖，字节保留', async () => {
    const srcV1 = makeSkillSource('a', 'v1');
    await skillInstallUserCommand(deps, srcV1);

    const srcV2 = makeSkillSource('b', 'v2');
    await expect(
      skillInstallUserCommand({ fsFactory: crashBeforeTargetsFactory() }, srcV2),
    ).rejects.toThrow(/simulated crash/);

    // 崩溃后 dispatch 目标内容被外部改变（preState 不再相符）
    fs.writeFileSync(path.join(dispatchSkillDir(), 'SKILL.md'), '# externally-changed\n');
    killHolder(claimPath());

    await expect(skillInstallUserCommand(deps, srcV2)).rejects.toThrow(/identity cannot be proven/);

    // 外部字节不被恢复覆盖；证据保留
    expect(fs.readFileSync(path.join(dispatchSkillDir(), 'SKILL.md'), 'utf-8')).toBe('# externally-changed\n');
    expect(fs.existsSync(claimPath())).toBe(true);
    // user 目标（preState 相符、未被触碰）已由恢复按 update 语义正常升级
    expect(readVersion(userSkillDir())).toBe('# myskill v2\n');
  });

  it('publishing target 被外部替换成无 marker 目录 → 不误判已提交，typed 冲突留证', async () => {
    const src = makeSkillSource('a', 'v1');
    // 崩溃：dispatch 落位中途（marker 在场、本 intent 占有）
    const dispatchParent = path.dirname(dispatchSkillDir());
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        real.linkExclusiveSync = () => { throw new Error('simulated crash mid-landing'); };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    // 外部删除半成品占位，重建无 marker 的目录（内容既非 manifest 亦非 preState）
    fs.rmSync(dispatchSkillDir(), { recursive: true, force: true });
    fs.mkdirSync(dispatchSkillDir(), { recursive: true });
    fs.writeFileSync(path.join(dispatchSkillDir(), 'SKILL.md'), '# external-replacement\n');
    killHolder(claimPath());

    await expect(skillInstallUserCommand(deps, src)).rejects.toThrow(/identity cannot be proven/);

    // 外部目录不被覆盖、不被误接受；claim 保留待显式处置
    expect(fs.readFileSync(path.join(dispatchSkillDir(), 'SKILL.md'), 'utf-8')).toBe('# external-replacement\n');
    expect(fs.existsSync(claimPath())).toBe(true);
  });

  it('publishing target 的 marker installId 不符（非本 intent 占有）→ typed 冲突留证', async () => {
    const src = makeSkillSource('a', 'v1');
    const dispatchParent = path.dirname(dispatchSkillDir());
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        real.linkExclusiveSync = () => { throw new Error('simulated crash mid-landing'); };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    // marker 在场但 installId 被改写（占有证据不符）
    const markerAbs = path.join(dispatchSkillDir(), SKILL_PUBLISH_MARKER);
    const marker = JSON.parse(fs.readFileSync(markerAbs, 'utf-8'));
    marker.installId = 'someone-else';
    fs.writeFileSync(markerAbs, JSON.stringify(marker, null, 2));
    killHolder(claimPath());

    await expect(skillInstallUserCommand(deps, src)).rejects.toThrow(/identity cannot be proven/);
    expect(fs.existsSync(markerAbs)).toBe(true);
    expect(fs.existsSync(claimPath())).toBe(true);
  });

  it('committing + 本方 marker 在场（提交点崩溃）→ 恢复完成提交：删 marker、目标完整可消费', async () => {
    const src = makeSkillSource('a', 'v1');
    // 崩溃：dispatch 提交点（committing 已登记、删 marker 时失败）
    const dispatchParent = path.dirname(dispatchSkillDir());
    let crashed = false;
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        const origDelete = real.deleteSync.bind(real);
        real.deleteSync = (p: string) => {
          if (!crashed && p === `myskill/${SKILL_PUBLISH_MARKER}`) {
            crashed = true;
            throw new Error('simulated crash at commit point');
          }
          return origDelete(p);
        };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    const crashedIntent = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    expect(crashedIntent.targets).toEqual([
      { id: 'user', state: 'published', preState: 'absent' },
      { id: 'dispatch', state: 'committing', preState: 'absent', commitBranch: 'absent' },
    ]);
    expect(fs.existsSync(path.join(dispatchSkillDir(), SKILL_PUBLISH_MARKER))).toBe(true);

    killHolder(claimPath());
    await skillInstallUserCommand(deps, src);

    // commit-finish：marker 删除 = 提交完成；registry 可消费完整版本
    expect(fs.existsSync(path.join(dispatchSkillDir(), SKILL_PUBLISH_MARKER))).toBe(false);
    expect(readVersion(dispatchSkillDir())).toBe('# myskill v1\n');
    expect(fs.existsSync(claimPath())).toBe(false);
    const registry = new SkillSystem(
      new NodeFileSystem({ baseDir: testDir }),
      path.relative(testDir, dispatchParent),
      { write: () => {} } as never,
    );
    await registry.loadAll();
    expect(registry.listMeta().map((m) => m.name)).toEqual(['myskill']);
  });

  it('committing + marker 在场但落位证据已破坏 → commit-finish 拒绝，冲突留证', async () => {
    const src = makeSkillSource('a', 'v1');
    const dispatchParent = path.dirname(dispatchSkillDir());
    let crashed = false;
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        const origDelete = real.deleteSync.bind(real);
        real.deleteSync = (p: string) => {
          if (!crashed && p === `myskill/${SKILL_PUBLISH_MARKER}`) {
            crashed = true;
            throw new Error('simulated crash at commit point');
          }
          return origDelete(p);
        };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    // 提交点崩溃后落位证据被外部破坏（额外文件混入）
    fs.writeFileSync(path.join(dispatchSkillDir(), 'external.txt'), 'x');
    killHolder(claimPath());

    await expect(skillInstallUserCommand(deps, src)).rejects.toThrow(/landing evidence is broken/);

    // marker 仍在（未提交），证据保留
    expect(fs.existsSync(path.join(dispatchSkillDir(), SKILL_PUBLISH_MARKER))).toBe(true);
    expect(fs.existsSync(claimPath())).toBe(true);
  });
});


describe('source snapshot 生命周期清理（Phase 1916 Step D：HYGIENE-SKILL-SOURCE-SNAPSHOT-ORPHAN）', () => {
  function killHolder(claimFile: string): void {
    const claim = JSON.parse(fs.readFileSync(claimFile, 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fs.writeFileSync(claimFile, JSON.stringify(claim, null, 2));
  }
  function skillDirSnapshots(): string[] {
    return fs.readdirSync(path.join(testDir, 'skills')).filter((n) => n.startsWith('.skill-srcsnap-'));
  }

  it('all-published 恢复（崩溃于 claim 释放前）→ 收敛释放 claim，快照零残留', async () => {
    const src = makeSkillSource('a', 'v1');
    // claim 释放失败（此刻快照已正常清理、全目标已 published）
    let crashed = false;
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(testDir)) {
        const origDelete = real.deleteSync.bind(real);
        real.deleteSync = (p: string) => {
          if (!crashed && p.endsWith('.myskill.installing')) {
            crashed = true;
            throw new Error('simulated claim release failure');
          }
          return origDelete(p);
        };
      }
      return real;
    };
    await skillInstallUserCommand({ fsFactory: crashingFactory }, src);

    // claim 残留（intent 全 published），快照已清理
    expect(fs.existsSync(claimPath())).toBe(true);
    const leftover = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    expect(leftover.targets.every((t: { state: string }) => t.state === 'published')).toBe(true);
    expect(skillDirSnapshots()).toEqual([]);

    killHolder(claimPath());
    await skillInstallUserCommand(deps, src);

    // all-published 恢复快速收敛：claim 释放、无快照孤儿
    expect(fs.existsSync(claimPath())).toBe(false);
    expect(skillDirSnapshots()).toEqual([]);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('resumed');
  });

  it('快照清理失败 → warn 可观察留证；下一次同名安装 sweep 收敛孤儿', async () => {
    const src = makeSkillSource('a', 'v1');
    const warnSpy = vi.mocked(console.warn);
    const skillsParent = path.join(testDir, 'skills');
    const failingCleanupFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(skillsParent)) {
        const origRemoveDir = real.removeDir.bind(real);
        real.removeDir = async (p: string) => {
          if (p.startsWith('.skill-srcsnap-')) throw new Error('simulated snapshot cleanup failure');
          return origRemoveDir(p);
        };
      }
      return real;
    };

    // 发布成功，但快照清理失败 → 孤儿残留 + warn 证据
    await skillInstallUserCommand({ fsFactory: failingCleanupFactory }, src);
    expect(readVersion(userSkillDir())).toBe('# myskill v1\n');
    expect(warnSpy.mock.calls.flat().join(' ')).toContain('skill source snapshot');
    expect(skillDirSnapshots()).toHaveLength(1);

    // 下一次同名安装：sweep 收敛孤儿（当前引用受保护、发布后清理）
    await skillInstallUserCommand(deps, src);
    expect(skillDirSnapshots()).toEqual([]);
  });

  it('恢复：当前 intent 引用的快照不被 sweep，同名孤儿被清扫', async () => {
    const src = makeSkillSource('a', 'v1');
    // 崩溃：dispatch 落位中途 → claim + 被引用快照残留
    const dispatchParent = path.dirname(dispatchSkillDir());
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        real.linkExclusiveSync = () => { throw new Error('simulated crash mid-landing'); };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);
    expect(skillDirSnapshots()).toHaveLength(1); // 被 intent 引用的快照在场

    // 同名孤儿快照（claim 写入前崩溃窗口的残留，无 intent 引用）
    const orphan = path.join(testDir, 'skills', '.skill-srcsnap-myskill-orphan00');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'SKILL.md'), 'orphan');

    killHolder(claimPath());
    await skillInstallUserCommand(deps, src);

    // 孤儿被清扫；引用快照完成恢复并随发布清理
    expect(fs.existsSync(orphan)).toBe(false);
    expect(readVersion(dispatchSkillDir())).toBe('# myskill v1\n');
    expect(skillDirSnapshots()).toEqual([]);
    expect(fs.existsSync(claimPath())).toBe(false);
  });
});
