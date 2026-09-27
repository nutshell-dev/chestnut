/**
 * Phase 1917 Step B — `chestnut skill list [--claw <id>]` 只读技能查看 CLI
 * （CLI-SKILL-LIST-MISSING / CLI-SKILL-LIST-FORMAT-DRIFT /
 * CLI-SKILL-LIST-PARTIAL-PUBLISH）
 *
 * 验收：
 * - Motion（默认）与指定 Claw 输出同一 owner 格式（formatForContext 原样）；
 * - `--claw motion` 与默认等价，绝不访问 .chestnut/claws/motion；
 * - 目标不存在 → typed 失败，不当空技能目录；
 * - 空目录保持 owner 空态字面；marker 在场的未提交目标不出现；
 * - 一次性 registry + fresh scan：第二次调用能看到磁盘上新提交的技能。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { skillListCommand } from '../../src/cli/commands/skill-list.js';
import { SKILL_PUBLISH_MARKER } from '../../src/foundation/skill-system/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

let testDir: string;
let originalRoot: string | undefined;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  testDir = await createTrackedTempDir('skill-list-');
  originalRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = testDir;
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  vi.restoreAllMocks();
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  await cleanupTempDir(testDir);
});

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

function makeDeps(loadClaw?: (configPath: string) => object | undefined) {
  return {
    fsFactory,
    rootConfig: {
      loadGlobal: () => ({} as never),
      loadClaw: loadClaw ?? ((configPath: string) => (
        configPath.includes('alice') || configPath.includes('empty-claw')
          ? ({} as never)
          : undefined
      )),
    },
  };
}

function writeSkill(skillsParent: string, name: string, description: string): void {
  const dir = path.join(skillsParent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\n---\n# ${name}\n`,
  );
}

function motionSkills(): string {
  return path.join(testDir, '.chestnut', 'motion', 'skills');
}
function clawSkills(id: string): string {
  return path.join(testDir, '.chestnut', 'claws', id, 'skills');
}

function stdout(): string {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
}

describe('skill list 只读查看（Phase 1917 Step B）', () => {
  it('Motion 默认目标：owner 格式原样输出（标题/行/排序）', async () => {
    writeSkill(motionSkills(), 'beta', 'second skill');
    writeSkill(motionSkills(), 'alpha', 'first skill');

    await skillListCommand(makeDeps(), {});

    expect(stdout()).toBe('## Available Skills\n- alpha: first skill\n- beta: second skill\n');
  });

  it('普通 Claw 目标：读取该 Claw 的 skills/，与 Motion 同一格式', async () => {
    writeSkill(motionSkills(), 'motion-skill', 'motion only');
    writeSkill(clawSkills('alice'), 'claw-skill', 'claw only');

    await skillListCommand(makeDeps(), { claw: 'alice' });

    expect(stdout()).toBe('## Available Skills\n- claw-skill: claw only\n');
  });

  it('--claw motion 与默认等价：不访问 .chestnut/claws/motion', async () => {
    writeSkill(motionSkills(), 'motion-skill', 'real motion');
    // 诱饵：普通 claws/motion 路径绝不被当作 Motion 目标
    writeSkill(clawSkills('motion'), 'decoy-skill', 'must not appear');

    await skillListCommand(makeDeps(), { claw: 'motion' });

    expect(stdout()).toBe('## Available Skills\n- motion-skill: real motion\n');
  });

  it('目标不存在 → typed 失败，不当空技能目录', async () => {
    await expect(skillListCommand(makeDeps(), { claw: 'missing' }))
      .rejects.toThrow('Claw "missing" does not exist');
    expect(stdout()).toBe('');
  });

  it('rootConfig 全局/Claw 配置失败原样上抛（不当空目录）', async () => {
    const failure = new Error('global config corrupt');
    const deps = makeDeps();
    deps.rootConfig.loadGlobal = () => { throw failure; };
    await expect(skillListCommand(deps, {})).rejects.toBe(failure);

    const clawFailure = new Error('claw config unreadable');
    await expect(skillListCommand(makeDeps(() => { throw clawFailure; }), { claw: 'alice' }))
      .rejects.toBe(clawFailure);
  });

  it('空技能目录 → owner 空态字面（No skills loaded.）', async () => {
    fs.mkdirSync(clawSkills('empty-claw'), { recursive: true });

    await skillListCommand(makeDeps(), { claw: 'empty-claw' });

    expect(stdout()).toBe('## Available Skills\nNo skills loaded.\n');
  });

  it('marker 在场的未提交目标不出现在列表（发布态门控复用 SkillSystem）', async () => {
    writeSkill(motionSkills(), 'committed-skill', 'done');
    writeSkill(motionSkills(), 'half-skill', 'publishing');
    fs.writeFileSync(
      path.join(motionSkills(), 'half-skill', SKILL_PUBLISH_MARKER),
      JSON.stringify({ source: '/tmp/x', startedAt: 't' }),
    );

    await skillListCommand(makeDeps(), {});

    expect(stdout()).toBe('## Available Skills\n- committed-skill: done\n');
  });

  it('一次性 registry + fresh scan：第二次调用看到磁盘上新提交的技能', async () => {
    writeSkill(motionSkills(), 'alpha', 'first skill');
    await skillListCommand(makeDeps(), {});
    expect(stdout()).toBe('## Available Skills\n- alpha: first skill\n');

    stdoutSpy.mockClear();
    writeSkill(motionSkills(), 'newly-committed', 'added later');

    await skillListCommand(makeDeps(), {});
    expect(stdout()).toBe('## Available Skills\n- alpha: first skill\n- newly-committed: added later\n');
  });
});
