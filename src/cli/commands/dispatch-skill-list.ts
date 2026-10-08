/**
 * `chestnut dispatch-skill list`（Phase 1929 Step C：dispatch 已发布技能列表）。
 *
 * 边界：
 * - 只列 dispatch 池**已发布**技能：元信息解析/排序/空态与行格式全部复用
 *   SkillVersions owner 的 `formatPublishedForContext()`（syncProjection →
 *   registry.loadAll → formatForContext）——CLI 不自己扫描 dispatch 仓库根、
 *   不解析 SKILL.md、不执行 Git；同名 Motion/Claw 自有副本不混入，未提交候选
 *   不出现；
 * - `observe_only` 仅表示不启动守护进程：factory 会做 baseline 迁移、自愈与
 *   派生投影维护（可能有文件写），如实声明，不承诺零磁盘副作用；
 * - 错误传播：损坏/迁移阻断（旧活动 intent/marker）非零失败，不伪装空集；
 * - list 不调用 beginEdit/submitEdit/importSkill——不产生新的用户编辑/发布；
 *   审计沿用 owner 路径（createDispatchVersions 同一装配）。
 *
 * Exit code semantics（同 audit 只读族）：0 = success / 1 = CliError only。
 */

import { getWorkspaceRoot } from '../../foundation/claw-identity/index.js';
import { SkillVersionError, type createSkillVersions } from '../../foundation/skill-system/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CliError } from '../errors.js';
import { createDispatchVersions } from './skill.js';

export interface DispatchSkillListDeps {
  fsFactory(baseDir: string): FileSystem;
}

export interface DispatchSkillListExtraDeps {
  audit?: AuditLog;
  createSkillVersions?: typeof createSkillVersions;
}

export async function dispatchSkillListCommand(
  deps: DispatchSkillListDeps,
  extraDeps?: DispatchSkillListExtraDeps,
): Promise<void> {
  let summary: string;
  try {
    const versions = await createDispatchVersions(deps, getWorkspaceRoot(), extraDeps?.audit, extraDeps?.createSkillVersions);
    summary = await versions.formatPublishedForContext();
  } catch (e) {
    if (e instanceof SkillVersionError) {
      throw new CliError(`Skill version service error (${e.kind}): ${e.message}`, { cause: e });
    }
    throw e;
  }
  process.stdout.write(`Dispatch skill pool (published):\n${summary}`);
}
