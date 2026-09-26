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
    // 模拟崩溃：dispatch 发布失败 → claim 残留（user=published, dispatch=pending）
    const dispatchParent = path.dirname(dispatchSkillDir());
    const crashingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(dispatchParent)) {
        real.moveDir = async () => { throw new Error('simulated crash at dispatch publish'); };
      }
      return real;
    };
    await expect(
      skillInstallUserCommand({ fsFactory: crashingFactory }, src),
    ).rejects.toThrow(/simulated crash/);

    // claim 残留、user 已发布、dispatch 未完成
    expect(fs.existsSync(claimPath())).toBe(true);
    expect(readVersion(userSkillDir())).toBe('# myskill v1\n');
    expect(fs.existsSync(dispatchSkillDir())).toBe(false);

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
        real.moveDir = async () => { throw new Error('simulated crash'); };
      }
      return real;
    };
    await expect(skillInstallUserCommand({ fsFactory: crashingFactory }, srcA)).rejects.toThrow();
    const claim = JSON.parse(fs.readFileSync(claimPath(), 'utf-8'));
    claim.pid = 99999;
    fs.writeFileSync(claimPath(), JSON.stringify(claim, null, 2));

    // 不同版本源重试 → 冲突，claim 证据保留，dispatch 不发布
    const srcB = makeSkillSource('b', 'vB');
    await expect(skillInstallUserCommand(deps, srcB)).rejects.toThrow(/different source payload/);
    expect(fs.existsSync(claimPath())).toBe(true);
    expect(fs.existsSync(dispatchSkillDir())).toBe(false);
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
