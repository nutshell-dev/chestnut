/**
 * Phase 1929 Step C：`dispatch-skill list` 已发布池列表契约测试。
 *
 * - 同名三份 fixture 隔离：Motion 自有、claw 自有、已发布池同名不同描述——
 *   列表只含已发布池版本，两个 list 各读正确 owner；
 * - 反向三项：仓库根只剩 .git 仍列出已发布技能（投影为读取面）；未发布候选
 *   不出现；服务损坏/迁移阻断非零失败（不伪装空集、cause 保留 typed 错误）；
 * - 重复列表不新增用户编辑/发布（允许 owner 初始化与派生投影维护的既有行为）。
 * - Phase 1929 Step F：注入 audit 时 owner 初始化/维护业务事件如实记录（非 noop）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { dispatchSkillListCommand } from '../../src/cli/commands/dispatch-skill-list.js';
import { CliError } from '../../src/cli/errors.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import {
  createSkillVersions,
  SkillVersionError,
  type SkillVersions,
} from '../../src/foundation/skill-system/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const SKILL_MD = (name: string, desc: string, body: string) =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

describe.skipIf(!gitAvailable)('dispatch-skill list（phase 1929 Step C）', () => {
  let tmpDir: string;
  let savedRoot: string | undefined;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  const deps = { fsFactory: (baseDir: string): FileSystem => new NodeFileSystem({ baseDir }) };
  const dispatchDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', 'dispatch-skills');
  const workspacesDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-workspaces');
  const versionStateDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-version-state');

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('dispatch-skill-list-');
    savedRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
    if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = savedRoot;
    await cleanupTempDir(tmpDir);
  });

  function stdout(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  async function makeVersions(): Promise<SkillVersions> {
    return createSkillVersions({
      repositoryDir: dispatchDir(),
      workspaceParent: workspacesDir(),
      stateDir: versionStateDir(),
      fsFactory: deps.fsFactory,
      audit: makeAudit().audit,
    });
  }

  /** 经 owner import 真发布一个技能（source 为真实目录，非 fake 字符串）。 */
  async function publish(name: string, desc: string, body: string): Promise<void> {
    const src = path.join(tmpDir, 'src-fixtures', name);
    fsSync.mkdirSync(src, { recursive: true });
    fsSync.writeFileSync(path.join(src, 'SKILL.md'), SKILL_MD(name, desc, body));
    const versions = await makeVersions();
    const result = await versions.importSkill({
      name,
      source: src,
      operationId: `test-publish-${name}-${Math.random().toString(36).slice(2, 10)}`,
      basis: { actor: 'user-install', reason: 'test fixture publish', sourceRefs: [src] },
    });
    expect(result.kind).toBe('published');
  }

  it('同名三份隔离：Motion/claw 自有副本不混入，列表只含已发布池版本', async () => {
    // Motion 自有副本（同名不同描述）
    const motionSkill = path.join(tmpDir, '.chestnut', 'motion', 'skills', 'shared');
    fsSync.mkdirSync(motionSkill, { recursive: true });
    fsSync.writeFileSync(path.join(motionSkill, 'SKILL.md'), SKILL_MD('shared', 'motion self copy', '# Motion\n'));
    // claw 自有副本（同名不同描述）
    const clawSkill = path.join(tmpDir, '.chestnut', 'claws', 'alice', 'skills', 'shared');
    fsSync.mkdirSync(clawSkill, { recursive: true });
    fsSync.writeFileSync(path.join(clawSkill, 'SKILL.md'), SKILL_MD('shared', 'claw self copy', '# Claw\n'));
    // 已发布池版本（同名不同描述）
    await publish('shared', 'dispatch pool published', '# Pool\n');

    await dispatchSkillListCommand(deps);

    const out = stdout();
    expect(out.startsWith('Dispatch skill pool (published):\n')).toBe(true);
    expect(out).toContain('shared: dispatch pool published');
    expect(out).not.toContain('motion self copy');
    expect(out).not.toContain('claw self copy');
  });

  it('空池：owner 空态原样呈现（不伪装、不静默消音）', async () => {
    await dispatchSkillListCommand(deps);

    expect(stdout()).toBe('Dispatch skill pool (published):\n## Available Skills\nNo skills loaded.\n');
  });

  it('仓库工作目录只剩 .git 仍列出已发布技能（投影为读取面，不扫描 live 根）', async () => {
    await publish('alpha', 'pool alpha', '# Alpha\n');
    await dispatchSkillListCommand(deps);
    expect(stdout()).toContain('alpha: pool alpha');

    // 抹掉仓库工作区文件（保留 .git）——旧「扫描空仓库根」思路会丢列表，投影不丢
    for (const entry of fsSync.readdirSync(dispatchDir())) {
      if (entry === '.git') continue;
      fsSync.rmSync(path.join(dispatchDir(), entry), { recursive: true, force: true });
    }
    stdoutSpy.mockClear();

    await dispatchSkillListCommand(deps);
    expect(stdout()).toContain('alpha: pool alpha');
  });

  it('未发布候选不出现；重复列表不新增编辑/发布事实', async () => {
    await publish('alpha', 'pool alpha v1', '# Alpha v1\n');
    // 未提交候选：begin 后只在工作区编辑，不 submit
    const versions = await makeVersions();
    const handle = await versions.beginEdit({
      skillName: 'alpha',
      requestId: 'test-candidate-1',
      basis: { actor: 'user', reason: 'candidate not published', sourceRefs: [] },
    });
    fsSync.writeFileSync(path.join(handle.path, 'SKILL.md'), SKILL_MD('alpha', 'candidate desc must not appear', '# C\n'));
    const headBefore = execSync('git rev-parse HEAD', { cwd: dispatchDir() }).toString().trim();

    await dispatchSkillListCommand(deps);
    stdoutSpy.mockClear();
    await dispatchSkillListCommand(deps);

    const out = stdout();
    expect(out).toContain('alpha: pool alpha v1');
    expect(out).not.toContain('candidate desc must not appear');
    // 重复列表不产生新提交（允许初始化/投影维护，不允许新发布）
    const headAfter = execSync('git rev-parse HEAD', { cwd: dispatchDir() }).toString().trim();
    expect(headAfter).toBe(headBefore);
    // 不产生新编辑事务记录
    const editsDir = path.join(versionStateDir(), 'edits');
    const editRecords = fsSync.existsSync(editsDir)
      ? fsSync.readdirSync(editsDir).filter((f) => f.endsWith('.json'))
      : [];
    expect(editRecords).toHaveLength(1); // 仅本测试 begin 的一笔
  });

  it('服务损坏/迁移阻断：非零 typed 失败，不伪装空集', async () => {
    // SkillVersionError（如 migration_blocked）→ CliError 保留 kind 与 cause
    const failing = new SkillVersionError('migration_blocked', 'legacy active intent blocks migration', { evidence: ['x'] });
    const failingFactory: typeof createSkillVersions = async () => {
      throw failing;
    };
    const err = await dispatchSkillListCommand(deps, { createSkillVersions: failingFactory }).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(String(err)).toContain('migration_blocked');
    expect((err as CliError & { cause?: unknown }).cause).toBe(failing); // typed 错误不吞
    expect(stdout()).toBe(''); // 失败不输出半个列表

    // 未知错误原样上抛（不吞咽成空列表）
    const boomFactory: typeof createSkillVersions = async () => { throw new Error('boom'); };
    await expect(dispatchSkillListCommand(deps, { createSkillVersions: boomFactory }))
      .rejects.toThrow('boom');
  });

  it('审计传递：owner 初始化/维护业务事件经注入 audit 记录（Phase 1929 Step F）', async () => {
    // 预置旧 live 树 → 首次构造版本服务触发 baseline 迁移业务事件
    const legacyDir = path.join(dispatchDir(), 'alpha');
    fsSync.mkdirSync(legacyDir, { recursive: true });
    fsSync.writeFileSync(path.join(legacyDir, 'SKILL.md'), SKILL_MD('alpha', 'legacy alpha', '# Alpha\n'));

    const { audit, events } = makeAudit();
    await dispatchSkillListCommand(deps, { audit });

    expect(events.some(([type]) => type === 'skill_version_baseline_created')).toBe(true);
    expect(stdout()).toContain('alpha: legacy alpha');
  });
});
