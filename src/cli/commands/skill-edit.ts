/**
 * `chestnut skill edit` + `chestnut skill history`（Phase 1919 Step D：
 * 技能分支编辑事务唯一 CLI 入口）。
 *
 * 边界：
 * - CLI 不执行 git、不 new Git wrapper：全部版本操作经 SkillVersions owner 服务
 *   （createDispatchVersions，与 skill install 同一装配）；
 * - 依据（basis）：--reason 必填——无理由不隐式生成虚构依据；
 *   CHESTNUT_SUBAGENT_TASK_ID 只作持久任务来源的**定位线索**（不作授权证据），
 *   经 ATS owner 窄查询（loadSubAgentTask）解析任务与 correlation 引用；
 *   解析不到 = 明确未归因（actor 'unattributed' + stderr note），绝不伪造 trace；
 * - submit 冲突 = 明确非零退出码 3 + 结构化 kind + 当前版本 + retry 指令；
 *   busy（CAS 有界重试耗尽）= 退出码 4，持久待重试，不伪装成语义冲突；
 * - status/history 只读：展示冲突候选与依据；不改变 1917 的提示词格式接口。
 */

import { getNamedSubrootDir, getWorkspaceRoot } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import {
  deriveShortIdFromTaskId,
  loadSubAgentTask,
  makeFullTaskId,
  type SubAgentTask,
} from '../../core/async-task-system/index.js';
import {
  SkillVersionError,
  type SkillBasis,
  type SkillEditInfo,
  type SkillHistoryEntry,
  type SkillVersions,
  type createSkillVersions,
} from '../../foundation/skill-system/index.js';
import { formatErr, newUuid } from '../../foundation/node-utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CliError } from '../errors.js';
import { createDispatchVersions } from './skill.js';

/** submit 冲突退出码（明确非零、与通用失败 1 区分；输出含结构化 kind=conflict） */
export const EXIT_EDIT_CONFLICT = 3;
/** publish busy（CAS 有界重试耗尽）退出码：持久待重试，重跑同一命令续作 */
export const EXIT_EDIT_BUSY = 4;

export interface SkillEditCommandDeps {
  fsFactory(baseDir: string): FileSystem;
}

export interface SkillEditExtraDeps {
  audit?: AuditLog;
  createSkillVersions?: typeof createSkillVersions;
}

async function openVersions(
  deps: SkillEditCommandDeps,
  extraDeps?: SkillEditExtraDeps,
): Promise<SkillVersions> {
  try {
    return await createDispatchVersions(deps, getWorkspaceRoot(), extraDeps?.audit, extraDeps?.createSkillVersions);
  } catch (e) {
    throw toCliError(e);
  }
}

/** SkillVersionError → CliError（保留 kind 语义；未知错误原样上抛） */
function toCliError(e: unknown): CliError | unknown {
  if (e instanceof SkillVersionError) {
    return new CliError(`Skill version service error (${e.kind}): ${e.message}`, { cause: e });
  }
  return e;
}

interface ResolvedBasis {
  basis: SkillBasis;
  /** 未归因说明（stderr 呈现；null = 归因完整或用户直接调用） */
  note: string | null;
}

/**
 * 依据解析：--reason 必填；CHESTNUT_SUBAGENT_TASK_ID 仅作持久任务的定位线索，
 * 经 ATS owner 窄查询解析；解析不到明确未归因（不伪造来源）。环境字符串不提升任何权限。
 */
export async function resolveEditBasis(
  deps: SkillEditCommandDeps,
  reason: string | undefined,
): Promise<ResolvedBasis> {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new CliError(
      '--reason <text> is required: the edit basis is recorded permanently and never fabricated',
    );
  }
  const taskId = process.env.CHESTNUT_SUBAGENT_TASK_ID;
  if (taskId === undefined || taskId === '') {
    return { basis: { actor: 'user', reason, sourceRefs: [] }, note: null };
  }
  let task: SubAgentTask | undefined;
  let resolutionFailure: string | null = null;
  try {
    task = taskId.length === 36
      ? await loadSubAgentTask(deps.fsFactory(getNamedSubrootDir(MOTION_CLAW_ID)), makeFullTaskId(taskId))
      : undefined;
  } catch (e) {
    // 解析失败不当成授权/归因证据：降级为未归因并留 note（结构化处理，不吞咽）
    resolutionFailure = formatErr(e);
  }
  if (task === undefined) {
    const detail = resolutionFailure !== null ? ` (${resolutionFailure})` : '';
    return {
      basis: { actor: 'unattributed', reason, sourceRefs: [] },
      note: `source task ${JSON.stringify(taskId)} not resolvable${detail}; attribution recorded as 'unattributed'`,
    };
  }
  const sourceRefs = [`subagent-task:${task.id}`];
  if (task.correlation?.ref !== undefined) {
    sourceRefs.push(`${task.correlation.source}:${task.correlation.ref}`);
  }
  return { basis: { actor: `subagent:${deriveShortIdFromTaskId(task.id)}`, reason, sourceRefs }, note: null };
}

/**
 * `chestnut skill edit begin <name> --reason <text>`：从最新 published 开分支工作区。
 * 输出稳定 editId、绝对工作目录、基准版本。
 */
export async function skillEditBeginCommand(
  deps: SkillEditCommandDeps,
  name: string,
  opts: { reason?: string },
  extraDeps?: SkillEditExtraDeps,
): Promise<void> {
  const { basis, note } = await resolveEditBasis(deps, opts.reason);
  const versions = await openVersions(deps, extraDeps);
  let handle;
  try {
    handle = await versions.beginEdit({ skillName: name, requestId: `cli-edit-${newUuid()}`, basis });
  } catch (e) {
    throw toCliError(e);
  }
  if (note !== null) process.stderr.write(`note: ${note}\n`);
  process.stdout.write([
    `Edit began: ${handle.editId}`,
    `Skill: ${handle.skillName}`,
    `Workspace: ${handle.path}`,
    `Base: ${handle.base}`,
    `Base path revision: ${handle.basePathRevision ?? 'none (new skill)'}`,
    `Next: edit files under the workspace, then run: chestnut skill edit submit ${handle.editId}`,
    '',
  ].join('\n'));
}

/**
 * `chestnut skill edit submit <edit-id>`：保存候选 + 条件发布。
 * 冲突 → 退出码 3 + kind=conflict + retry 指令；busy → 退出码 4（待重试，同命令续作）。
 */
export async function skillEditSubmitCommand(
  deps: SkillEditCommandDeps,
  editId: string,
  extraDeps?: SkillEditExtraDeps,
): Promise<void> {
  const versions = await openVersions(deps, extraDeps);
  let result;
  try {
    result = await versions.submitEdit(editId);
  } catch (e) {
    throw toCliError(e);
  }
  if (result.kind === 'published') {
    process.stdout.write(`Edit ${editId} published: ${result.version}\n`);
    return;
  }
  if (result.kind === 'conflict') {
    throw new CliError(
      `Edit ${editId} failed (kind=conflict): the skill was updated concurrently\n` +
      `current: ${result.current}\n` +
      `candidate retained (not overwritten, not merged): ${result.candidate}\n` +
      `retry on the latest base: chestnut skill edit retry ${editId}`,
      EXIT_EDIT_CONFLICT,
    );
  }
  throw new CliError(
    `Edit ${editId} not yet published (kind=busy): publish CAS retries exhausted; ` +
    `candidate retained with operation ${result.operationId}\n` +
    `resume with the same command: chestnut skill edit submit ${editId}`,
    EXIT_EDIT_BUSY,
  );
}

/**
 * `chestnut skill edit retry <edit-id>`：对 conflict 编辑从最新 published 新建
 * 关联分支（parentEditId 链接）；绝不 reset 原分支、不自动 merge。
 */
export async function skillEditRetryCommand(
  deps: SkillEditCommandDeps,
  editId: string,
  extraDeps?: SkillEditExtraDeps,
): Promise<void> {
  const versions = await openVersions(deps, extraDeps);
  let handle;
  try {
    handle = await versions.retryEdit({ editId, requestId: `cli-retry-${newUuid()}` });
  } catch (e) {
    throw toCliError(e);
  }
  process.stdout.write([
    `Retry edit began: ${handle.editId} (parent: ${editId})`,
    `Skill: ${handle.skillName}`,
    `Workspace: ${handle.path}`,
    `Base: ${handle.base}`,
    `Base path revision: ${handle.basePathRevision ?? 'none (new skill)'}`,
    `Next: re-apply your changes on this fresh base, then run: chestnut skill edit submit ${handle.editId}`,
    '',
  ].join('\n'));
}

function formatSourceRefs(info: SkillEditInfo): string {
  return info.basis.sourceRefs.length > 0 ? info.basis.sourceRefs.join(', ') : 'none';
}

function formatEditInfo(info: SkillEditInfo): string[] {
  const lines = [
    `Edit: ${info.editId}`,
    `Skill: ${info.skillName}`,
    `Status: ${info.status}`,
    `Base: ${info.base}`,
    `Base path revision: ${info.basePathRevision ?? 'none (new skill)'}`,
    `Candidate: ${info.candidate ?? 'none'}`,
    `Version: ${info.version ?? 'none'}`,
    `Current: ${info.current ?? 'none'}`,
    `Parent edit: ${info.parentEditId ?? 'none'}`,
  ];
  if (info.status === 'saved' && info.publishOperationId !== null) {
    // busy/中断未决：持久呈现为待重试，不伪装终态
    lines.push(`Publish: pending retry (operation ${info.publishOperationId}; resume: chestnut skill edit submit ${info.editId})`);
  }
  lines.push(
    `Actor: ${info.basis.actor}`,
    `Reason: ${info.basis.reason}`,
    `Source refs: ${formatSourceRefs(info)}`,
    `Created: ${info.createdAt}`,
    `Updated: ${info.updatedAt}`,
  );
  return lines;
}

/** `chestnut skill edit status <edit-id>`（只读）：事务状态 + 冲突候选 + 依据。 */
export async function skillEditStatusCommand(
  deps: SkillEditCommandDeps,
  editId: string,
  extraDeps?: SkillEditExtraDeps,
): Promise<void> {
  const versions = await openVersions(deps, extraDeps);
  let info: SkillEditInfo;
  try {
    info = await versions.editStatus(editId);
  } catch (e) {
    if (e instanceof SkillVersionError && e.kind === 'not_found') {
      throw new CliError(`Unknown edit "${editId}" (nothing written)`, { cause: e });
    }
    throw toCliError(e);
  }
  process.stdout.write(`${formatEditInfo(info).join('\n')}\n`);
}

/**
 * Phase 1923 Step B：提交历史条目渲染——version/operationId/commit 时间/提交状态/
 * 编辑事务身份/依据（actor/reason/sourceRefs）。sourceRefs 只含任务/对象定位，
 * 可交给既有日志 owner 查询；缺失字段显式呈现，绝不伪造。
 */
function formatHistoryEntry(entry: SkillHistoryEntry): string[] {
  const lines = [
    `Version: ${entry.version ?? 'none (not published)'}`,
    `At: ${entry.at}`,
    `Operation: ${entry.operationId ?? 'none (not recorded)'}`,
    `Status: ${entry.status}`,
    `Edit: ${entry.editId ?? 'none'}`,
  ];
  if (entry.basis !== null) {
    lines.push(
      `Actor: ${entry.basis.actor}`,
      `Reason: ${entry.basis.reason}`,
      `Source refs: ${entry.basis.sourceRefs.length > 0 ? entry.basis.sourceRefs.join(', ') : 'none'}`,
    );
  } else {
    lines.push(
      'Actor: missing (legacy record without persisted basis; not fabricated)',
      'Reason: missing',
      'Source refs: missing',
    );
  }
  return lines;
}

/**
 * `chestnut skill history <name>`（只读）：技能版本提交历史（新→旧）——
 * Snapshot 已发布事实与编辑事务按 publishOperationId 对账后的完整提交信息。
 */
export async function skillHistoryCommand(
  deps: SkillEditCommandDeps,
  name: string,
  extraDeps?: SkillEditExtraDeps,
): Promise<void> {
  const versions = await openVersions(deps, extraDeps);
  let entries: readonly SkillHistoryEntry[];
  try {
    entries = await versions.skillHistory(name);
  } catch (e) {
    throw toCliError(e);
  }
  if (entries.length === 0) {
    process.stdout.write(`No history for skill "${name}".\n`);
    return;
  }
  const blocks = entries.map((entry) => formatHistoryEntry(entry).join('\n'));
  process.stdout.write(`History for skill "${name}" (newest first):\n\n${blocks.join('\n\n')}\n`);
}
