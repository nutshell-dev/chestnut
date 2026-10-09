/**
 * Phase 1930 Step C：本地安装事务进入实例的真实 CLI 验收。
 *
 * - 真实 CLI（spawn `node dist/cli.js`）临时实例 fresh install：实例父目录
 *   零新增写入（`skills/` 不创建）；Motion 自有副本与 dispatch 池版本内容正确；
 * - 父目录已有用户文件：安装后原字节保留、无事务工件混入；
 * - 中断事务（claim + 来源快照在新 namespace `.chestnut/skill-install/local/`）：
 *   真实 CLI 恢复完成、工件收敛、父目录始终无写入。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { skillInstallUserCommand } from '../../src/cli/commands/skill.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { createSkillVersions, type SkillVersions } from '../../src/foundation/skill-system/index.js';
import { newUuid } from '../../src/foundation/node-utils/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const CLI_ENTRY = path.resolve(process.cwd(), 'dist/cli.js');

const SKILL_MD = (name: string, desc: string, body: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

describe.skipIf(!gitAvailable)('skill install 事务入实例（Phase 1930 Step C，真实 CLI）', () => {
  let tmpDir: string;

  const deps = { fsFactory: (baseDir: string): FileSystem => new NodeFileSystem({ baseDir }) };
  const parentSkillsDir = () => path.join(tmpDir, 'skills');
  const claimParent = () => path.join(tmpDir, '.chestnut', 'skill-install', 'local');
  const claimPath = () => path.join(claimParent(), '.myskill.installing');
  const motionSkillDir = () => path.join(tmpDir, '.chestnut', 'motion', 'skills', 'myskill');

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-install-instance-root-');
    // 真实 CLI 子进程需要最小全局配置与存活 watchdog owner（同 scope 测试既定模式）
    fsSync.mkdirSync(path.join(tmpDir, '.chestnut', 'watchdog', 'active'), { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, '.chestnut', 'watchdog', 'active', 'owner.json'), JSON.stringify({
      schema_version: 1,
      attempt_id: newUuid(),
      owner_token: newUuid(),
      pid: process.pid,
      process_start_time: 'test',
      workspace_root: tmpDir,
      created_at: new Date().toISOString(),
    }));
    fsSync.writeFileSync(
      path.join(tmpDir, '.chestnut', 'config.yaml'),
      'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude-test\n',
    );
  });

  afterEach(async () => {
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

  function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve, reject) => {
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
  }

  it('fresh install：父目录零新增写入，Motion/池内容正确，claim 释放', async () => {
    const src = makeSkillSource('a', 'local origin', 'v1');

    const res = await runCli(['skill', 'install', src]);
    expect(res.exitCode).toBe(0);

    // 父目录零新增写入：skills/ 不存在（无 claim、无快照、无目标残留）
    expect(fsSync.existsSync(parentSkillsDir())).toBe(false);
    // Motion 自有副本与池版本内容正确
    expect(fsSync.readFileSync(path.join(motionSkillDir(), 'SKILL.md'), 'utf-8')).toContain('# myskill v1');
    expect(await (await makeVersions()).loadPublished('myskill')).toContain('# myskill v1');
    // 事务工件收敛：新 namespace 无 claim / 快照残留
    expect(fsSync.existsSync(claimPath())).toBe(false);
    const leftovers = fsSync.existsSync(claimParent())
      ? fsSync.readdirSync(claimParent()).filter((n) => n.startsWith('.'))
      : [];
    expect(leftovers).toEqual([]);
  }, 120_000);

  it('父目录已有用户文件：安装后原字节保留、无事务工件混入', async () => {
    // 已有外部用户文件（既有 workspace/skills 内容不自动迁移/删除）
    fsSync.mkdirSync(parentSkillsDir(), { recursive: true });
    const userFile = path.join(parentSkillsDir(), 'user-owned.txt');
    const userBytes = 'user owned content — do not touch\n';
    fsSync.writeFileSync(userFile, userBytes);

    const src = makeSkillSource('a', 'local origin', 'v1');
    const res = await runCli(['skill', 'install', src]);
    expect(res.exitCode).toBe(0);

    expect(fsSync.readFileSync(userFile, 'utf-8')).toBe(userBytes);
    expect(fsSync.readdirSync(parentSkillsDir())).toEqual(['user-owned.txt']);
    expect(fsSync.existsSync(motionSkillDir())).toBe(true);
  }, 120_000);

  it('中断事务：claim/快照在新 namespace，真实 CLI 恢复完成并收敛', async () => {
    const src = makeSkillSource('a', 'local origin', 'v1');
    // 崩溃现场（in-process DI 缝）：dispatch 发布中途崩溃——Motion 已 published、
    // 池未发布；claim + 被引用快照必须留在实例内新 namespace
    const savedRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    try {
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
    } finally {
      if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
      else process.env.CHESTNUT_ROOT = savedRoot;
    }

    // 故障后 claim/快照在新 namespace；父目录零写入
    expect(fsSync.existsSync(claimPath())).toBe(true);
    const crashedIntent = JSON.parse(fsSync.readFileSync(claimPath(), 'utf-8'));
    expect(crashedIntent.schema_version).toBe(4);
    const snapshots = fsSync.readdirSync(claimParent()).filter((n) => n.startsWith('.skill-srcsnap-'));
    expect(snapshots).toHaveLength(1);
    expect(fsSync.existsSync(parentSkillsDir())).toBe(false);
    expect(fsSync.readFileSync(path.join(motionSkillDir(), 'SKILL.md'), 'utf-8')).toContain('# myskill v1');

    // holder 判死（崩溃进程 pid 已不存在），真实 CLI 恢复
    const claim = JSON.parse(fsSync.readFileSync(claimPath(), 'utf-8'));
    claim.pid = 99999;
    delete claim.process_start_time;
    fsSync.writeFileSync(claimPath(), JSON.stringify(claim, null, 2));

    const res = await runCli(['skill', 'install', src]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('resumed');

    // 恢复完成：池版本补齐、claim/快照收敛、父目录仍零写入
    expect(await (await makeVersions()).loadPublished('myskill')).toContain('# myskill v1');
    expect(fsSync.existsSync(claimPath())).toBe(false);
    expect(
      fsSync.readdirSync(claimParent()).filter((n) => n.startsWith('.')),
    ).toEqual([]);
    expect(fsSync.existsSync(parentSkillsDir())).toBe(false);
  }, 120_000);
});
