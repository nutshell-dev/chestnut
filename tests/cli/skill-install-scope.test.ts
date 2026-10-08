/**
 * Phase 1929 Step D：安装来源/目标对齐契约测试。
 *
 * - 本地安装双目标可见性：Motion 自有副本（skill list 默认目标真可见）+
 *   dispatch 池正式版本；workspace 根 skills/ 不再是安装目标；
 * - 同名隔离：安装后编辑 Motion 自有副本不改池版本；池→claw 安装取池固定版本；
 * - Motion 特殊路径：池→motion 安装落 getNamedSubrootDir('motion')/skills，
 *   绝不产生 claws/motion；
 * - 非法参数组合（source+--skill / source+--claw / --claw 缺 --skill / 全缺）
 *   在真实 CLI 上非零拒绝且零安装副作用；
 * - 旧布局（workspace/skills 目标）中断 intent 明确拒绝恢复：证据保留、目标
 *   不改写；本 phase 的 schema-4 Motion intent 正常恢复；
 * - 两个安装入口竞争同一 Motion 目标：至多一个占有者，最终内容为单一完整版本；
 * - 双目标中途失败：已提交目标事实保留（Motion 副本在、池未发布、claim 留证），
 *   不伪造全局成功。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync, spawn } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { skillInstallUserCommand, skillInstallClawCommand } from '../../src/cli/commands/skill.js';
import { skillListCommand } from '../../src/cli/commands/skill-list.js';
import { CliError } from '../../src/cli/errors.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { createSkillVersions, SkillSystem, type SkillVersions } from '../../src/foundation/skill-system/index.js';
import { newUuid } from '../../src/foundation/node-utils/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const SKILL_MD = (name: string, desc: string, body: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

describe.skipIf(!gitAvailable)('skill install 来源/目标对齐（phase 1929 Step D）', () => {
  let tmpDir: string;
  let savedRoot: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  const deps = { fsFactory: (baseDir: string): FileSystem => new NodeFileSystem({ baseDir }) };
  const motionSkills = () => path.join(tmpDir, '.chestnut', 'motion', 'skills');
  const motionSkillDir = () => path.join(motionSkills(), 'myskill');
  const workspaceSkillDir = () => path.join(tmpDir, 'skills', 'myskill');
  const rootClaimPath = () => path.join(tmpDir, 'skills', '.myskill.installing');

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-install-scope-');
    savedRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = savedRoot;
    await cleanupTempDir(tmpDir);
  });

  function makeSkillSource(parent: string, desc: string, version: string): string {
    const src = path.join(tmpDir, parent, 'myskill');
    fsSync.mkdirSync(src, { recursive: true });
    fsSync.writeFileSync(path.join(src, 'SKILL.md'), SKILL_MD('myskill', desc, `# myskill ${version}\n`));
    fsSync.writeFileSync(path.join(src, 'run.sh'), `echo ${version}\n`);
    return src;
  }

  async function makeVersions(): Promise<SkillVersions> {
    const clawspace = path.join(tmpDir, '.chestnut', 'motion', 'clawspace');
    return createSkillVersions({
      repositoryDir: path.join(clawspace, 'dispatch-skills'),
      workspaceParent: path.join(clawspace, '.dispatch-workspaces'),
      stateDir: path.join(clawspace, '.dispatch-version-state'),
      fsFactory: deps.fsFactory,
      audit: makeAudit().audit,
    });
  }

  function killHolder(claimFile: string): void {
    const claim = JSON.parse(fsSync.readFileSync(claimFile, 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fsSync.writeFileSync(claimFile, JSON.stringify(claim, null, 2));
  }

  it('本地安装双目标：Motion list 真可见 + 池版本在；workspace 根 skills 不再是目标', async () => {
    const src = makeSkillSource('a', 'local origin', 'v1');

    await skillInstallUserCommand(deps, src);

    // Motion 自有副本（getNamedSubrootDir('motion')/skills），绝不写 claws/motion
    expect(fsSync.readFileSync(path.join(motionSkillDir(), 'SKILL.md'), 'utf-8')).toContain('# myskill v1');
    expect(fsSync.existsSync(path.join(tmpDir, '.chestnut', 'claws', 'motion'))).toBe(false);
    // workspace 根 skills/<name> 不再是安装目标
    expect(fsSync.existsSync(workspaceSkillDir())).toBe(false);

    // skill list（默认 Motion 目标）真可见
    await skillListCommand(
      { fsFactory: deps.fsFactory, rootConfig: { loadGlobal: () => ({} as never), loadClaw: () => undefined } },
      {},
    );
    const listOut = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(listOut).toContain('myskill: local origin');

    // 池版本存在且内容一致
    const versions = await makeVersions();
    expect(await versions.loadPublished('myskill')).toContain('# myskill v1');

    // 成功输出明确两目标
    const logs = logSpy.mock.calls.flat().join('\n');
    expect(logs).toContain('.chestnut/motion/skills/myskill');
    expect(logs).toContain('dispatch pool');
  });

  it('同名隔离：安装后编辑 Motion 自有副本不改池版本；池→claw 取池固定版本', async () => {
    const src = makeSkillSource('a', 'origin', 'v1');
    await skillInstallUserCommand(deps, src);

    // 用户自主编辑 Motion 自有副本
    fsSync.writeFileSync(path.join(motionSkillDir(), 'SKILL.md'), SKILL_MD('myskill', 'motion edited', '# myskill USER-EDITED\n'));

    // 池版本不变
    const versions = await makeVersions();
    expect(await versions.loadPublished('myskill')).toContain('# myskill v1');

    // 池→claw 安装得到池版本，不是 Motion 编辑
    fsSync.mkdirSync(path.join(tmpDir, '.chestnut', 'claws', 'bob'), { recursive: true });
    await skillInstallClawCommand(deps, 'bob', 'myskill');
    expect(fsSync.readFileSync(path.join(tmpDir, '.chestnut', 'claws', 'bob', 'skills', 'myskill', 'SKILL.md'), 'utf-8'))
      .toContain('# myskill v1');
    // Motion 自有副本不被池安装反向改写
    expect(fsSync.readFileSync(path.join(motionSkillDir(), 'SKILL.md'), 'utf-8')).toContain('USER-EDITED');
  });

  it('池→Motion 安装（默认目标）：落 Motion 自有 skills，无 claws/motion', async () => {
    const src = makeSkillSource('a', 'origin', 'v1');
    // 先经本地安装建立池版本（Motion 副本随后删除，模拟只保留池的场景）
    await skillInstallUserCommand(deps, src);
    fsSync.rmSync(motionSkillDir(), { recursive: true, force: true });

    await skillInstallClawCommand(deps, 'motion', 'myskill');

    expect(fsSync.readFileSync(path.join(motionSkillDir(), 'SKILL.md'), 'utf-8')).toContain('# myskill v1');
    expect(fsSync.existsSync(path.join(tmpDir, '.chestnut', 'claws', 'motion'))).toBe(false);
    // Motion target-local claim 已释放，无协议残留
    expect(fsSync.readdirSync(motionSkills()).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('旧布局中断 intent（schema<4 user 目标）：接管前零改写拒绝，factory 零调用', async () => {
    // 手工 fixture：D 之前版本的 user install 中断 intent（user 目标 = workspace/skills）
    const intent = {
      schema_version: 2,
      token: 'tok-legacy',
      id: 'install-legacy',
      skillName: 'myskill',
      source: path.join(tmpDir, 'a', 'myskill'),
      pid: 99999, // holder 已死
      startedAt: new Date().toISOString(),
      manifest: [],
      sourceSnapshot: '.skill-srcsnap-myskill-tok-legacy',
      targets: [
        { id: 'user', state: 'publishing', preState: 'absent' },
        { id: 'dispatch', state: 'pending', preState: 'absent' },
      ],
    };
    fsSync.mkdirSync(path.join(tmpDir, 'skills'), { recursive: true });
    const claimBytes = JSON.stringify(intent, null, 2);
    fsSync.writeFileSync(rootClaimPath(), claimBytes);
    // 旧布局中断现场：workspace 目标半成品 + marker
    fsSync.mkdirSync(workspaceSkillDir(), { recursive: true });
    fsSync.writeFileSync(path.join(workspaceSkillDir(), 'SKILL.md'), '# half-installed\n');
    fsSync.writeFileSync(path.join(workspaceSkillDir(), '.skill-publishing'), '{}');

    const src = makeSkillSource('a', 'origin', 'v1');
    let factoryCalls = 0;
    const countingFactory: typeof createSkillVersions = async (opts) => {
      factoryCalls++;
      return createSkillVersions(opts);
    };

    // Phase 1929 Step E：版本服务构造前就拒绝——factory 零调用
    await expect(skillInstallUserCommand(deps, src, { createSkillVersions: countingFactory }))
      .rejects.toThrow(/legacy workspace skills target/);
    expect(factoryCalls).toBe(0);

    // 原始磁盘证据逐字节不变（无 holder 接管写入）；snapshot/marker 不动
    expect(fsSync.readFileSync(rootClaimPath(), 'utf-8')).toBe(claimBytes);
    expect(fsSync.existsSync(path.join(workspaceSkillDir(), '.skill-publishing'))).toBe(true);
    expect(fsSync.readFileSync(path.join(workspaceSkillDir(), 'SKILL.md'), 'utf-8')).toBe('# half-installed\n');
    expect(fsSync.existsSync(motionSkillDir())).toBe(false);

    // 同进程第二次尝试：仍是布局错误而非 in-progress（从未接管，pid 不被改写）
    await expect(skillInstallUserCommand(deps, src, { createSkillVersions: countingFactory }))
      .rejects.toThrow(/legacy workspace skills target/);
    expect(factoryCalls).toBe(0);
    expect(fsSync.readFileSync(rootClaimPath(), 'utf-8')).toBe(claimBytes);
  });

  it('损坏 claim：fail-loud 不当 absent，零改写零 factory 调用', async () => {
    fsSync.mkdirSync(path.join(tmpDir, 'skills'), { recursive: true });
    fsSync.writeFileSync(rootClaimPath(), '{corrupted');

    const src = makeSkillSource('a', 'origin', 'v1');
    let factoryCalls = 0;
    const countingFactory: typeof createSkillVersions = async (opts) => {
      factoryCalls++;
      return createSkillVersions(opts);
    };
    await expect(skillInstallUserCommand(deps, src, { createSkillVersions: countingFactory }))
      .rejects.toThrow(/malformed/);
    expect(factoryCalls).toBe(0);
    expect(fsSync.readFileSync(rootClaimPath(), 'utf-8')).toBe('{corrupted');
  });

  it('未知 schema 的 claim：接管前拒绝，证据保留', async () => {
    const intent = {
      schema_version: 9,
      token: 'tok-future',
      id: 'install-future',
      skillName: 'myskill',
      source: path.join(tmpDir, 'a', 'myskill'),
      pid: 99999,
      startedAt: new Date().toISOString(),
      manifest: [],
      targets: [{ id: 'user', state: 'pending', preState: 'absent' }],
    };
    fsSync.mkdirSync(path.join(tmpDir, 'skills'), { recursive: true });
    const claimBytes = JSON.stringify(intent, null, 2);
    fsSync.writeFileSync(rootClaimPath(), claimBytes);

    const src = makeSkillSource('a', 'origin', 'v1');
    let factoryCalls = 0;
    const countingFactory: typeof createSkillVersions = async (opts) => {
      factoryCalls++;
      return createSkillVersions(opts);
    };
    await expect(skillInstallUserCommand(deps, src, { createSkillVersions: countingFactory }))
      .rejects.toThrow(/unsupported schema version/);
    expect(factoryCalls).toBe(0);
    expect(fsSync.readFileSync(rootClaimPath(), 'utf-8')).toBe(claimBytes);
  });

  it('竞态窗口：入口前检后出现的旧 claim 在接管前仍被拒绝（factory 可已装配，claim 零改写）', async () => {
    const intent = {
      schema_version: 2,
      token: 'tok-race',
      id: 'install-race',
      skillName: 'myskill',
      source: path.join(tmpDir, 'a', 'myskill'),
      pid: 99999,
      startedAt: new Date().toISOString(),
      manifest: [],
      targets: [{ id: 'user', state: 'pending', preState: 'absent' }],
    };
    fsSync.mkdirSync(path.join(tmpDir, 'skills'), { recursive: true });
    const claimBytes = JSON.stringify(intent, null, 2);
    fsSync.writeFileSync(rootClaimPath(), claimBytes);

    // 入口前检的首次 readSync 伪装缺席（竞态前瞬间），此后读真实文件——
    // 覆盖「前检通过 → 旧 claim 出现 → 接管前二次判定」窗口
    let probeReads = 0;
    const raceFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(tmpDir)) {
        const origRead = real.readSync.bind(real);
        real.readSync = (p: string) => {
          if (p === 'skills/.myskill.installing' && probeReads === 0) {
            probeReads++;
            const err = new Error('simulated pre-check absent') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          }
          return origRead(p);
        };
      }
      return real;
    };

    let factoryCalls = 0;
    const countingFactory: typeof createSkillVersions = async (opts) => {
      factoryCalls++;
      return createSkillVersions(opts);
    };
    const src = makeSkillSource('a', 'origin', 'v1');
    await expect(
      skillInstallUserCommand({ fsFactory: raceFactory }, src, { createSkillVersions: countingFactory }),
    ).rejects.toThrow(/legacy workspace skills target/);
    // 竞态路径不谎称 factory 零调用；但旧 claim 必须零改写、无接管
    expect(fsSync.readFileSync(rootClaimPath(), 'utf-8')).toBe(claimBytes);
    expect(fsSync.existsSync(motionSkillDir())).toBe(false);
  });

  it('本 phase 的 Motion 布局中断 intent（schema 4）：正常恢复完成两目标', async () => {
    const src = makeSkillSource('a', 'origin', 'v1');
    // 崩溃：dispatch 发布中途（Motion 已 published、dispatch=publishing）
    const crashFactory: typeof createSkillVersions = async (opts) => {
      const real = await createSkillVersions(opts);
      return {
        readPublished: real.readPublished.bind(real),
        loadPublished: real.loadPublished.bind(real),
        formatPublishedForContext: real.formatPublishedForContext.bind(real),
        importSkill: async () => { throw new Error('simulated crash at dispatch publish'); },
      };
    };
    await expect(
      skillInstallUserCommand(deps, src, { createSkillVersions: crashFactory }),
    ).rejects.toThrow(/simulated crash/);

    // 部分提交事实显式保留：Motion 副本已提交、池未发布、claim 留证；不伪造成功输出
    expect(fsSync.readFileSync(path.join(motionSkillDir(), 'SKILL.md'), 'utf-8')).toContain('# myskill v1');
    await expect((await makeVersions()).readPublished('myskill')).rejects.toMatchObject({ kind: 'not_found' });
    expect(fsSync.existsSync(rootClaimPath())).toBe(true);
    const crashedIntent = JSON.parse(fsSync.readFileSync(rootClaimPath(), 'utf-8'));
    expect(crashedIntent.schema_version).toBe(4);
    expect(crashedIntent.targets).toEqual([
      { id: 'user', state: 'published', preState: 'absent' },
      { id: 'dispatch', state: 'publishing', preState: 'absent' },
    ]);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Installed');

    // schema-4 恢复：正常补齐 dispatch 目标
    killHolder(rootClaimPath());
    await skillInstallUserCommand(deps, src);
    expect(await (await makeVersions()).loadPublished('myskill')).toContain('# myskill v1');
    expect(fsSync.existsSync(rootClaimPath())).toBe(false);
  });

  it('两个安装入口竞争同一 Motion 目标：至多一个占有者，最终单一完整版本', async () => {
    // 池里已有 v1（经本地安装发布）
    await skillInstallUserCommand(deps, makeSkillSource('a', 'origin', 'v1'));
    // 移除 Motion 副本，构造两入口同时争抢空目标的场景
    fsSync.rmSync(motionSkillDir(), { recursive: true, force: true });
    const srcLocal = makeSkillSource('b', 'local contender', 'vL');

    const results = await Promise.allSettled([
      skillInstallUserCommand(deps, srcLocal),
      skillInstallClawCommand(deps, 'motion', 'myskill'),
    ]);

    // 失败只能是 typed 占有冲突（绝不允许 last-writer-wins 静默覆盖半成品）
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(CliError);
        expect((r.reason as CliError).message).toMatch(
          /in progress|appeared concurrently|identity cannot be proven|conflict/i,
        );
      }
    }
    // 最终 Motion 目标是单一完整版本（SKILL.md 与 run.sh 同源成对）
    const skillMd = fsSync.readFileSync(path.join(motionSkillDir(), 'SKILL.md'), 'utf-8');
    const runSh = fsSync.readFileSync(path.join(motionSkillDir(), 'run.sh'), 'utf-8');
    const isLocal = skillMd.includes('vL');
    expect(runSh).toBe(isLocal ? 'echo vL\n' : 'echo v1\n');
    expect(skillMd).toContain(isLocal ? '# myskill vL' : '# myskill v1');
  });

  it('真实 CLI：非法参数组合非零拒绝且零安装副作用', async () => {
    const CLI_ENTRY = path.resolve(process.cwd(), 'dist/cli.js');
    expect(fsSync.existsSync(CLI_ENTRY)).toBe(true);
    // 预置存活 watchdog owner（pid=本测试进程；NODE_ENV=test 旁路 argv 校验）
    const activeDir = path.join(tmpDir, '.chestnut', 'watchdog', 'active');
    fsSync.mkdirSync(activeDir, { recursive: true });
    fsSync.writeFileSync(path.join(activeDir, 'owner.json'), JSON.stringify({
      schema_version: 1,
      attempt_id: newUuid(),
      owner_token: newUuid(),
      pid: process.pid,
      process_start_time: 'test',
      workspace_root: tmpDir,
      created_at: new Date().toISOString(),
    }));
    const src = makeSkillSource('a', 'origin', 'v1');
    // 池来源安装会 loadGlobal（与旧 --claw 路径一致）：预置最小全局配置
    fsSync.writeFileSync(
      path.join(tmpDir, '.chestnut', 'config.yaml'),
      'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude-test\n',
    );

    const runCli = (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
      new Promise((resolve, reject) => {
        const child = spawn('node', [CLI_ENTRY, ...args], {
          env: { ...process.env, CHESTNUT_ROOT: tmpDir, NODE_ENV: 'test', GIT_CONFIG_NOSYSTEM: '1' },
          cwd: tmpDir,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => { stdout += d.toString(); });
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
      });

    // source + --skill / source + --claw / --claw 缺 --skill / 全缺：全部非零拒绝
    for (const args of [
      ['skill', 'install', src, '--skill', 'myskill'],
      ['skill', 'install', src, '--claw', 'bob'],
      ['skill', 'install', '--claw', 'bob'],
      ['skill', 'install'],
    ]) {
      const res = await runCli(args);
      expect(res.exitCode).not.toBe(0);
    }
    const conflict = await runCli(['skill', 'install', src, '--skill', 'myskill']);
    expect(conflict.stderr).toContain('mutually exclusive');

    // 零安装副作用：Motion 无副本、池无版本、无 claim 残留
    expect(fsSync.existsSync(motionSkillDir())).toBe(false);
    expect(fsSync.existsSync(workspaceSkillDir())).toBe(false);
    expect(fsSync.existsSync(rootClaimPath())).toBe(false);
    await expect((await makeVersions()).readPublished('myskill')).rejects.toMatchObject({ kind: 'not_found' });

    // 合法新形态：--skill 缺省目标 = motion
    await skillInstallUserCommand(deps, src);
    fsSync.rmSync(motionSkillDir(), { recursive: true, force: true });
    const ok = await runCli(['skill', 'install', '--skill', 'myskill']);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('Motion self skills');
    expect(fsSync.existsSync(path.join(motionSkillDir(), 'SKILL.md'))).toBe(true);
    expect(fsSync.existsSync(path.join(tmpDir, '.chestnut', 'claws', 'motion'))).toBe(false);
  }, 120_000);
});
