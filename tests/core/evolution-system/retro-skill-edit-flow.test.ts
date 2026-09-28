/**
 * Phase 1919 Step E：复盘分支编辑工作流端到端测试（脚本化子代理，真实 Git）。
 *
 * 两个复盘任务并发编辑同一 dispatch 技能：A 提交成功、B 收冲突（非成功信号）、
 * B retry 取得最新基准分支重做后发布；编辑历史与来源（subagent-task + retro
 * correlation）可追溯。timeout/中断的候选与依据持久留存，不伪报已发布。
 *
 * 子代理 = 持久 retro 任务文件（buildRetroSubagentPayload 真实构造的 correlation
 * 与身份）+ CHESTNUT_SUBAGENT_TASK_ID 环境注入（command-tool 同款机制）+ CLI
 * handler 驱动（D 已验收真实 spawn 链，本测试聚焦工作流语义）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { buildRetroSubagentPayload } from '../../../src/core/evolution-system/retro-scheduler.js';
import {
  skillEditBeginCommand,
  skillEditRetryCommand,
  skillEditStatusCommand,
  skillEditSubmitCommand,
} from '../../../src/cli/commands/skill-edit.js';
import { CliError } from '../../../src/cli/errors.js';
import { EXIT_EDIT_CONFLICT } from '../../../src/cli/commands/skill-edit.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import {
  createSkillVersions,
  type SkillVersions,
} from '../../../src/foundation/skill-system/index.js';
import {
  deriveShortIdFromTaskId,
  makeFullTaskId,
  TASKS_QUEUES_PENDING_DIR,
} from '../../../src/core/async-task-system/index.js';
import { newUuid } from '../../../src/foundation/node-utils/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

const SKILL_MD = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`;
const CONTRACT_ID = 'c-retro-1';

describe.skipIf(!gitAvailable)('复盘分支编辑工作流（phase 1919 Step E）', () => {
  let tmpDir: string;
  let savedRoot: string | undefined;
  let savedTaskEnv: string | undefined;

  const deps = { fsFactory: (baseDir: string): FileSystem => new NodeFileSystem({ baseDir }) };
  const dispatchDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', 'dispatch-skills');
  const workspacesDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-workspaces');
  const versionStateDir = () => path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-version-state');

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('retro-skill-edit-');
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

  async function makeVersions(): Promise<SkillVersions> {
    return createSkillVersions({
      repositoryDir: dispatchDir(),
      workspaceParent: workspacesDir(),
      stateDir: versionStateDir(),
      fsFactory: deps.fsFactory,
      audit: makeAudit().audit,
    });
  }

  function captureStdout(): { lines: string[]; restore: () => void; text: () => string } {
    const lines: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { lines.push(String(s)); return true; }) as typeof process.stdout.write;
    return { lines, restore: () => { process.stdout.write = orig; }, text: () => lines.join('') };
  }

  /** 持久化一个 retro 任务（identity + correlation 来自真实 payload builder） */
  async function persistRetroTask(versions: SkillVersions): Promise<{ id: string; correlationRef: string }> {
    const payload = await buildRetroSubagentPayload({
      targetClaw: 'claw-x',
      contractId: CONTRACT_ID as never,
      contractYaml: 'schema_version: 1\ntitle: t\n',
      motionFs: deps.fsFactory(path.join(tmpDir, '.chestnut', 'motion')),
      audit: makeAudit().audit,
      skillVersions: versions,
    });
    // Step D：持久来源引用随任务落盘
    expect(payload.correlation).toEqual({ source: 'retro', ref: CONTRACT_ID });
    // 工作流提示词在 intent 中（旧共享写指令零命中）
    expect(payload.intent).toContain('chestnut skill edit begin');
    expect(payload.intent).not.toContain('用 write 工具写入 dispatch-skill');

    const id = newUuid();
    const dir = path.join(tmpDir, '.chestnut', 'motion', TASKS_QUEUES_PENDING_DIR);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
      kind: 'subagent',
      id,
      shortId: deriveShortIdFromTaskId(makeFullTaskId(id)),
      timeoutMs: payload.timeoutMs,
      parentClawId: 'motion',
      createdAt: new Date().toISOString(),
      intent: payload.intent,
      correlation: payload.correlation,
    }));
    return { id, correlationRef: `retro:${CONTRACT_ID}` };
  }

  /** 脚本化子代理：env 注入任务 id（command-tool 同款）后执行 CLI 命令 */
  async function runAs<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    process.env.CHESTNUT_SUBAGENT_TASK_ID = taskId;
    try {
      return await fn();
    } finally {
      delete process.env.CHESTNUT_SUBAGENT_TASK_ID;
    }
  }

  async function beginVia(name: string, reason: string): Promise<{ editId: string; workspace: string }> {
    const cap = captureStdout();
    try {
      await skillEditBeginCommand(deps, name, { reason });
    } finally {
      cap.restore();
    }
    const editId = /Edit began: (\S+)/.exec(cap.text())?.[1];
    const workspace = /Workspace: (\S+)/.exec(cap.text())?.[1];
    if (!editId || !workspace) throw new Error(`begin output not parseable:\n${cap.text()}`);
    return { editId, workspace };
  }

  it('两复盘任务同技能并发：A 发布、B 冲突（非成功）、retry 重做发布；历史与来源可追溯', async () => {
    // 既有技能 v1（baseline 迁移入版本库）
    const skillDir = path.join(dispatchDir(), 'report-pattern');
    fsSync.mkdirSync(skillDir, { recursive: true });
    fsSync.writeFileSync(path.join(skillDir, 'SKILL.md'), SKILL_MD('report-pattern', '# Report v1\n'));
    const versions = await makeVersions();
    expect(await versions.loadPublished('report-pattern')).toContain('# Report v1');

    const taskA = await persistRetroTask(versions);
    const taskB = await persistRetroTask(versions);

    // B 先 begin（与 A 同基准），A 后 begin——交错并发
    const bBegin = await runAs(taskB.id, () => beginVia('report-pattern', 'B: retry/backoff 经验'));
    const aBegin = await runAs(taskA.id, () => beginVia('report-pattern', 'A: 日志聚合经验'));
    expect(bBegin.editId).not.toBe(aBegin.editId);

    fsSync.writeFileSync(path.join(aBegin.workspace, 'SKILL.md'), SKILL_MD('report-pattern', '# Report v1\n\n## A 日志聚合\n'));
    fsSync.writeFileSync(path.join(bBegin.workspace, 'SKILL.md'), SKILL_MD('report-pattern', '# Report v1\n\n## B backoff\n'));

    // A 提交成功
    const capA = captureStdout();
    try {
      await runAs(taskA.id, () => skillEditSubmitCommand(deps, aBegin.editId));
    } finally {
      capA.restore();
    }
    expect(capA.text()).toContain(`Edit ${aBegin.editId} published: `);

    // B 提交 → 冲突（明确非成功：CliError code 3，kind=conflict，含 retry 指令）
    const conflictErr = await runAs(taskB.id, () =>
      skillEditSubmitCommand(deps, bBegin.editId).catch((e: unknown) => e));
    expect(conflictErr).toBeInstanceOf(CliError);
    expect((conflictErr as CliError).code).toBe(EXIT_EDIT_CONFLICT);
    expect((conflictErr as CliError).message).toContain('kind=conflict');
    expect((conflictErr as CliError).message).toContain(`chestnut skill edit retry ${bBegin.editId}`);

    // B retry：新分支基于最新版本（含 A 的内容），重新应用自己的经验后发布
    const retryOut = await runAs(taskB.id, async () => {
      const cap = captureStdout();
      try {
        await skillEditRetryCommand(deps, bBegin.editId);
      } finally {
        cap.restore();
      }
      return cap.text();
    });
    const bRetryId = /Retry edit began: (\S+)/.exec(retryOut)?.[1] ?? '';
    const bRetryWs = /Workspace: (\S+)/.exec(retryOut)?.[1] ?? '';
    expect(bRetryId).not.toBe('');
    expect(fsSync.readFileSync(path.join(bRetryWs, 'SKILL.md'), 'utf8')).toContain('## A 日志聚合');
    fsSync.writeFileSync(path.join(bRetryWs, 'SKILL.md'), SKILL_MD('report-pattern', '# Report v1\n\n## A 日志聚合\n\n## B backoff\n'));

    const capB = captureStdout();
    try {
      await runAs(taskB.id, () => skillEditSubmitCommand(deps, bRetryId));
    } finally {
      capB.restore();
    }
    expect(capB.text()).toContain(`Edit ${bRetryId} published: `);
    expect(await versions.loadPublished('report-pattern')).toContain('## B backoff');
    expect(await versions.loadPublished('report-pattern')).toContain('## A 日志聚合');

    // 历史与来源可追溯：A 发布（retro:contract + subagent-task）、B 冲突记录、
    // B' 发布且 parentEditId 链接 B（新→旧；B 的 begin 最早，故排最后）
    const history = await versions.editHistory('report-pattern');
    expect(history.map(i => i.status)).toEqual(['published', 'published', 'conflict']);
    const [bRetry, aPublished, bConflict] = history;
    expect(bRetry.editId).toBe(bRetryId);
    expect(bRetry.parentEditId).toBe(bBegin.editId);
    expect(bRetry.version).toMatch(/^[0-9a-f]{40}$/);
    expect(bConflict.editId).toBe(bBegin.editId);
    expect(bConflict.candidate).toMatch(/^[0-9a-f]{40}$/);
    expect(bConflict.current).toBe(aPublished.version);
    expect(aPublished.basis.actor).toBe(`subagent:${deriveShortIdFromTaskId(makeFullTaskId(taskA.id))}`);
    expect(aPublished.basis.sourceRefs).toEqual([`subagent-task:${taskA.id}`, taskA.correlationRef]);
    expect(bConflict.basis.sourceRefs).toEqual([`subagent-task:${taskB.id}`, taskB.correlationRef]);
  });

  it('timeout/中断：工作区与候选留存、依据不丢，不伪报已发布', async () => {
    const versions = await makeVersions();
    const taskC = await persistRetroTask(versions);

    // 子代理 begin + 编辑后「超时」：进程 abandons，无 submit
    const cBegin = await runAs(taskC.id, () => beginVia('timeout-skill', 'C: 中断留存经验'));
    fsSync.mkdirSync(cBegin.workspace, { recursive: true });
    fsSync.writeFileSync(path.join(cBegin.workspace, 'SKILL.md'), SKILL_MD('timeout-skill', '# Timeout draft\n'));

    // 记录持久可查：editing 状态、依据完整；未发布不入 published 视图
    const info = await versions.editStatus(cBegin.editId);
    expect(info.status).toBe('editing');
    expect(info.version).toBeNull();
    expect(info.basis.reason).toBe('C: 中断留存经验');
    expect(info.basis.sourceRefs).toEqual([`subagent-task:${taskC.id}`, taskC.correlationRef]);
    expect(fsSync.existsSync(cBegin.workspace)).toBe(true); // 工作区留存
    await expect(versions.readPublished('timeout-skill')).rejects.toMatchObject({ kind: 'not_found' });

    // 显式取消：先保存可保存内容再登记，候选长期可读
    const cancelled = await versions.cancelEdit(cBegin.editId);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.candidate).toMatch(/^[0-9a-f]{40}$/);
    // 历史仍呈现 cancelled（含候选与依据），不消失
    const history = await versions.editHistory('timeout-skill');
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('cancelled');
  });
});
