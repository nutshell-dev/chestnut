/**
 * Phase 1919 Step D：技能分支编辑事务 CLI（skill edit begin/submit/retry/status +
 * skill history）契约测试。
 *
 * - handler 级（真实 Git 版本库 fixture）：begin→edit→submit 全链、冲突退出码 3 +
 *   retry 指令、busy 退出码 4（exec 锁注入）、retry 链接 parent、status/history
 *   只读展示候选与依据
 * - 反向三项：未知 edit 不落盘 / 越界路径不落盘 / 冲突非成功；缺 --reason 拒绝且
 *   不隐式生成虚构依据；来源任务解析不到 = 明确未归因而非伪造
 * - 真实链：spawn `node dist/cli.js`（CHESTNUT_ROOT 指向临时工作区 + 预置存活
 *   watchdog owner + 持久 retro 任务），验证 cwd 无关、工作区可达、CLI 准入
 *   （catalog 注册）与来源引用完整（subagent-task + retro correlation）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync, spawn } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import {
  EXIT_EDIT_BUSY,
  EXIT_EDIT_CONFLICT,
  skillEditBeginCommand,
  skillEditRetryCommand,
  skillEditStatusCommand,
  skillEditSubmitCommand,
  skillHistoryCommand,
} from '../../src/cli/commands/skill-edit.js';
import { CliError } from '../../src/cli/errors.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import {
  createSkillVersions,
  type SkillVersionsOptions,
} from '../../src/foundation/skill-system/index.js';
import {
  deriveShortIdFromTaskId,
  makeFullTaskId,
  TASKS_QUEUES_PENDING_DIR,
} from '../../src/core/async-task-system/index.js';
import { newUuid } from '../../src/foundation/node-utils/index.js';
import { makeAudit } from '../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const SKILL_MD = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`;

describe.skipIf(!gitAvailable)('skill edit CLI（phase 1919 Step D）', () => {
  let tmpDir: string;
  let savedRoot: string | undefined;
  let savedTaskEnv: string | undefined;

  const deps = { fsFactory: (baseDir: string): FileSystem => new NodeFileSystem({ baseDir }) };
  const dispatchDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', 'dispatch-skills');
  const workspacesDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-workspaces');
  const versionStateDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-version-state');
  const motionDir = () => path.join(tmpDir, '.chestnut', 'motion');

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('skill-edit-cli-');
    savedRoot = process.env.CHESTNUT_ROOT;
    savedTaskEnv = process.env.CHESTNUT_SUBAGENT_TASK_ID;
    process.env.CHESTNUT_ROOT = tmpDir;
    delete process.env.CHESTNUT_SUBAGENT_TASK_ID;
  });

  afterEach(async () => {
    if (savedRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = savedRoot;
    if (savedTaskEnv === undefined) delete process.env.CHESTNUT_SUBAGENT_TASK_ID;
    else process.env.CHESTNUT_SUBAGENT_TASK_ID = savedTaskEnv;
    await cleanupTempDir(tmpDir);
  });

  function seedDispatchSkill(name: string, body: string): void {
    const dir = path.join(dispatchDir(), name);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD(name, body));
  }

  /** 捕获 handler stdout/stderr（输出契约断言用） */
  function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => { stdout.push(String(s)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => { stderr.push(String(s)); return true; }) as typeof process.stderr.write;
    return { stdout, stderr, restore: () => { process.stdout.write = origOut; process.stderr.write = origErr; } };
  }

  /** 在工作区写文件并提交，返回 begin 输出文本 */
  async function beginEdit(name: string, reason: string): Promise<{ editId: string; workspace: string; out: string }> {
    const cap = captureOutput();
    try {
      await skillEditBeginCommand(deps, name, { reason });
    } finally {
      cap.restore();
    }
    const out = cap.stdout.join('');
    const editId = /Edit began: (\S+)/.exec(out)?.[1];
    const workspace = /Workspace: (\S+)/.exec(out)?.[1];
    if (!editId || !workspace) throw new Error(`begin output not parseable:\n${out}`);
    return { editId, workspace, out };
  }

  function writeWs(workspace: string, rel: string, content: string): void {
    const abs = path.join(workspace, rel);
    fsSync.mkdirSync(path.dirname(abs), { recursive: true });
    fsSync.writeFileSync(abs, content);
  }

  it('begin→edit→submit→published 全链；status/history 展示依据；--reason 必填不造假', async () => {
    seedDispatchSkill('alpha', '# Alpha orig\n');

    // 缺 --reason：拒绝且任何服务状态都不落盘（不隐式生成虚构依据）
    await expect(skillEditBeginCommand(deps, 'alpha', {})).rejects.toThrow(CliError);
    expect(fsSync.existsSync(versionStateDir())).toBe(false);

    const { editId, workspace, out } = await beginEdit('alpha', 'improve alpha wording');
    expect(out).toContain(`Base path revision: `);
    expect(out).toContain(`chestnut skill edit submit ${editId}`);
    expect(workspace.startsWith(workspacesDir())).toBe(true);

    writeWs(workspace, 'SKILL.md', SKILL_MD('alpha', '# Alpha v2\n'));
    const cap = captureOutput();
    try {
      await skillEditSubmitCommand(deps, editId);
      await skillEditStatusCommand(deps, editId);
      await skillHistoryCommand(deps, 'alpha');
    } finally {
      cap.restore();
    }
    const text = cap.stdout.join('');
    expect(text).toContain(`Edit ${editId} published: `);
    expect(text).toContain('Status: published');
    expect(text).toContain('Actor: user');
    expect(text).toContain('Reason: improve alpha wording');
    expect(text).toContain('Source refs: none');
    expect(text).toContain(`Edit history for skill "alpha" (newest first):`);

    // 固定版本读取反映新内容（经 owner 服务复核）
    const versions = await createSkillVersions({
      repositoryDir: dispatchDir(),
      workspaceParent: workspacesDir(),
      stateDir: versionStateDir(),
      fsFactory: deps.fsFactory,
      audit: makeAudit().audit,
    });
    expect(await versions.loadPublished('alpha')).toContain('# Alpha v2');
  });

  it('未知 edit / 越界技能名：typed 拒绝且不落盘', async () => {
    seedDispatchSkill('alpha', '# Alpha orig\n');
    await expect(skillEditStatusCommand(deps, 'edit-does-not-exist')).rejects.toThrow(/Unknown edit/);
    await expect(skillEditSubmitCommand(deps, 'edit-does-not-exist')).rejects.toThrow(CliError);
    // 服务已就绪（baseline 迁移的工作区属 Step B 正常产物）——快照现状，
    // 非法 begin 不得新增任何工作区/事务记录
    const workspacesBefore = fsSync.existsSync(workspacesDir()) ? fsSync.readdirSync(workspacesDir()) : [];
    await expect(skillEditBeginCommand(deps, '../evil', { reason: 'x' })).rejects.toThrow(CliError);
    await expect(skillEditBeginCommand(deps, 'UPPER', { reason: 'x' })).rejects.toThrow(CliError);
    // 不落盘：无事务记录、工作区集合不变
    const editsDir = path.join(versionStateDir(), 'edits');
    if (fsSync.existsSync(editsDir)) {
      expect(fsSync.readdirSync(editsDir).filter(f => f.endsWith('.json'))).toEqual([]);
    }
    const workspacesAfter = fsSync.existsSync(workspacesDir()) ? fsSync.readdirSync(workspacesDir()) : [];
    expect(workspacesAfter).toEqual(workspacesBefore);
  });

  it('submit 冲突：退出码 3 + kind=conflict + 当前版本 + retry 指令（冲突非成功）', async () => {
    seedDispatchSkill('alpha', '# Alpha orig\n');
    const a = await beginEdit('alpha', 'A change');
    const b = await beginEdit('alpha', 'B change');
    writeWs(a.workspace, 'SKILL.md', SKILL_MD('alpha', '# Alpha by A\n'));
    writeWs(b.workspace, 'SKILL.md', SKILL_MD('alpha', '# Alpha by B\n'));
    await skillEditSubmitCommand(deps, a.editId);

    const err = await skillEditSubmitCommand(deps, b.editId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const cliErr = err as CliError;
    expect(cliErr.code).toBe(EXIT_EDIT_CONFLICT);
    expect(cliErr.message).toContain('kind=conflict');
    expect(cliErr.message).toMatch(/current: [0-9a-f]{40}/);
    expect(cliErr.message).toContain(`chestnut skill edit retry ${b.editId}`);
    expect(cliErr.message).toMatch(/candidate retained.*[0-9a-f]{40}/);
  });

  it('busy：CAS 锁注入耗尽 → 退出码 4 + kind=busy；解锁后同命令续作发布', async () => {
    seedDispatchSkill('alpha', '# Alpha orig\n');
    const realExec = (await import('../../src/foundation/process-exec/index.js')).exec;
    const lock = { held: true };
    const lockExec = (async (file: string, args: string[], opts: unknown) => {
      if (lock.held && args.includes('update-ref') && args.includes('refs/version/published')) {
        const err = new Error('simulated ref lock') as Error & { exitCode: number; output: string };
        err.exitCode = 1;
        err.output = 'cannot lock ref: simulated';
        throw err;
      }
      return realExec(file as 'git', args, opts as never);
    }) as typeof realExec;
    const lockingFactory: typeof createSkillVersions = (opts: SkillVersionsOptions) =>
      createSkillVersions({ ...opts, exec: lockExec });

    const { editId, workspace } = await beginEdit('alpha', 'busy path');
    writeWs(workspace, 'SKILL.md', SKILL_MD('alpha', '# Alpha busy\n'));
    const err = await skillEditSubmitCommand(deps, editId, { createSkillVersions: lockingFactory }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(EXIT_EDIT_BUSY);
    expect((err as CliError).message).toContain('kind=busy');
    expect((err as CliError).message).toContain(`chestnut skill edit submit ${editId}`);

    // 解锁续作（服务侧幂等恢复）
    lock.held = false;
    const cap = captureOutput();
    try {
      await skillEditSubmitCommand(deps, editId);
    } finally {
      cap.restore();
    }
    expect(cap.stdout.join('')).toContain(`Edit ${editId} published: `);
  });

  it('retry：新分支链接 parent，从最新基准重做发布', async () => {
    seedDispatchSkill('alpha', '# Alpha orig\n');
    const a = await beginEdit('alpha', 'A wins');
    const b = await beginEdit('alpha', 'B loses then retries');
    writeWs(a.workspace, 'SKILL.md', SKILL_MD('alpha', '# Alpha by A\n'));
    writeWs(b.workspace, 'SKILL.md', SKILL_MD('alpha', '# Alpha by B\n'));
    await skillEditSubmitCommand(deps, a.editId);
    await expect(skillEditSubmitCommand(deps, b.editId)).rejects.toMatchObject({ code: EXIT_EDIT_CONFLICT });

    const cap = captureOutput();
    let retryEditId = '';
    try {
      await skillEditRetryCommand(deps, b.editId);
      const out = cap.stdout.join('');
      expect(out).toContain(`(parent: ${b.editId})`);
      retryEditId = /Retry edit began: (\S+)/.exec(out)?.[1] ?? '';
      expect(retryEditId).not.toBe('');
      const ws = /Workspace: (\S+)/.exec(out)?.[1] ?? '';
      // 新工作区含最新已发布内容（A 的版本），重新应用修改后发布成功
      expect(fsSync.readFileSync(path.join(ws, 'SKILL.md'), 'utf8')).toContain('# Alpha by A');
      writeWs(ws, 'SKILL.md', SKILL_MD('alpha', '# Alpha by B retry\n'));
      cap.stdout.length = 0;
      await skillEditSubmitCommand(deps, retryEditId);
    } finally {
      cap.restore();
    }
    expect(cap.stdout.join('')).toContain(`Edit ${retryEditId} published: `);
  });

  it('来源归因：任务可解析 → subagent-task + correlation 引用；不可解析 → 明确未归因', async () => {
    seedDispatchSkill('alpha', '# Alpha orig\n');

    // 1) 持久 retro 任务在场（CHESTNUT_SUBAGENT_TASK_ID 仅作定位线索）
    const taskId = newUuid();
    const taskDir = path.join(motionDir(), TASKS_QUEUES_PENDING_DIR);
    fsSync.mkdirSync(taskDir, { recursive: true });
    fsSync.writeFileSync(path.join(taskDir, `${taskId}.json`), JSON.stringify({
      kind: 'subagent',
      id: taskId,
      shortId: deriveShortIdFromTaskId(makeFullTaskId(taskId)),
      timeoutMs: 600000,
      parentClawId: 'motion',
      createdAt: new Date().toISOString(),
      intent: 'retro prompt',
      correlation: { source: 'retro', ref: 'contract-xyz' },
    }));
    process.env.CHESTNUT_SUBAGENT_TASK_ID = taskId;

    const attributed = await beginEdit('alpha', 'retro improvement');
    writeWs(attributed.workspace, 'SKILL.md', SKILL_MD('alpha', '# Alpha retro\n'));
    await skillEditSubmitCommand(deps, attributed.editId);
    const cap = captureOutput();
    try {
      await skillHistoryCommand(deps, 'alpha');
    } finally {
      cap.restore();
    }
    const historyText = cap.stdout.join('');
    expect(historyText).toContain(`Actor: subagent:${deriveShortIdFromTaskId(makeFullTaskId(taskId))}`);
    expect(historyText).toContain(`subagent-task:${taskId}`);
    expect(historyText).toContain('retro:contract-xyz');

    // 2) 任务不可解析（env 存在但无持久任务）：未归因 + stderr note，不伪造来源
    process.env.CHESTNUT_SUBAGENT_TASK_ID = newUuid();
    const cap2 = captureOutput();
    try {
      await skillEditBeginCommand(deps, 'alpha', { reason: 'orphan env' });
      cap2.stdout.length = 0;
      await skillHistoryCommand(deps, 'alpha');
    } finally {
      cap2.restore();
    }
    expect(cap2.stderr.join('')).toContain("attribution recorded as 'unattributed'");
    expect(cap2.stdout.join('')).toContain('Actor: unattributed');
  });

  it('真实链：subagent runner→CLI→owner（spawn dist/cli.js，cwd 无关，来源引用完整）', async () => {
    const CLI_ENTRY = path.resolve(process.cwd(), 'dist/cli.js');
    expect(fsSync.existsSync(CLI_ENTRY)).toBe(true);
    const foreignCwd = await createTrackedTempDir('skill-edit-cli-cwd-');
    try {

    seedDispatchSkill('alpha', '# Alpha orig\n');
    // 预置存活 watchdog owner（pid=本测试进程；NODE_ENV=test 旁路 argv 校验）→
    // 'required' 策略 alive fast-path，不 spawn 真实 watchdog
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
    // 持久 retro 任务（correlation 来源引用）
    const taskId = newUuid();
    const taskDir = path.join(motionDir(), TASKS_QUEUES_PENDING_DIR);
    fsSync.mkdirSync(taskDir, { recursive: true });
    fsSync.writeFileSync(path.join(taskDir, `${taskId}.json`), JSON.stringify({
      kind: 'subagent',
      id: taskId,
      shortId: deriveShortIdFromTaskId(makeFullTaskId(taskId)),
      timeoutMs: 600000,
      parentClawId: 'motion',
      createdAt: new Date().toISOString(),
      intent: 'retro prompt',
      correlation: { source: 'retro', ref: 'contract-real-chain' },
    }));

    const runCli = (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
      new Promise((resolve, reject) => {
        const child = spawn('node', [CLI_ENTRY, ...args], {
          env: {
            ...process.env,
            CHESTNUT_ROOT: tmpDir,
            NODE_ENV: 'test',
            CHESTNUT_SUBAGENT_TASK_ID: taskId,
            GIT_CONFIG_NOSYSTEM: '1',
          },
          cwd: foreignCwd, // cwd 无关性：工作区经 CHESTNUT_ROOT 定位（异目录）
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => { stdout += d.toString(); });
        child.stderr?.on('data', (d) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
      });

    const begin = await runCli(['skill', 'edit', 'begin', 'alpha', '--reason', 'real chain edit']);
    expect(begin.exitCode).toBe(0);
    expect(begin.stderr).not.toContain('unattributed');
    const editId = /Edit began: (\S+)/.exec(begin.stdout)?.[1] ?? '';
    const workspace = /Workspace: (\S+)/.exec(begin.stdout)?.[1] ?? '';
    expect(editId).toMatch(/^edit-[0-9a-f]{24}$/);
    expect(workspace.startsWith(workspacesDir())).toBe(true);
    expect(begin.stdout).toMatch(/Base: [0-9a-f]{40}/);

    writeWs(workspace, 'SKILL.md', SKILL_MD('alpha', '# Alpha real chain\n'));
    const submit = await runCli(['skill', 'edit', 'submit', editId]);
    expect(submit.exitCode).toBe(0);
    expect(submit.stdout).toContain(`Edit ${editId} published: `);

    const status = await runCli(['skill', 'edit', 'status', editId]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('Status: published');
    expect(status.stdout).toContain(`subagent-task:${taskId}`);
    expect(status.stdout).toContain('retro:contract-real-chain');

    const history = await runCli(['skill', 'history', 'alpha']);
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain(editId);
    expect(history.stdout).toContain('real chain edit');

    // 反向：未知 edit 退出码非零（CLI 准入路径 typed 拒绝）
    const unknown = await runCli(['skill', 'edit', 'status', 'edit-nonexistent']);
    expect(unknown.exitCode).not.toBe(0);
    } finally {
      await cleanupTempDir(foreignCwd);
    }
  }, 120_000);
});
