/**
 * `chestnut skill list` subcommand（Phase 1917 Step B，CLI-SKILL-LIST-MISSING）
 *
 * 只读查看 Motion 或指定 Claw 的技能元信息。语义边界：
 * - 元信息解析、marker 发布态门控、排序、空态与行格式全部由 SkillSystem
 *   owner 提供——CLI 只选择 base directory 并原样输出 `formatForContext()`，
 *   不复制 `## Available Skills` / `- name: description` / `No skills loaded.`
 *   字面（CLI-SKILL-LIST-FORMAT-DRIFT）；
 * - 每次命令创建一次性 registry 并完成 fresh scan：看到的是磁盘上已提交的
 *   最新元信息（marker 在场的未提交目标不出现，
 *   CLI-SKILL-LIST-PARTIAL-PUBLISH），不宣称刷新运行中 Claw 的常驻 registry；
 * - 只读：不创建/修改 skill、claim、marker、registry 持久状态，audit 用
 *   noop（同 audit info 的 read-only 边界，不发 audit 事件）。
 *
 * Exit code semantics（同 audit 只读族）：0 = success / 1 = CliError only。
 */

import { getClawConfigPath, getClawDir, getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { createSkillSystem, SKILLS_DIR_DEFAULT } from '../../foundation/skill-system/index.js';
import { noopAuditLog } from '../../foundation/audit/index.js';
import type { RootConfigReader } from '../../assembly/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { CliError } from '../errors.js';

export interface SkillListDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal' | 'loadClaw'>;
}

export async function skillListCommand(
  deps: SkillListDeps,
  opts: { claw?: string },
): Promise<void> {
  // 目标解析（同 audit 只读族边界）：不传或 `motion` → Motion 特殊目录
  // （不能把 motion 当普通 claws/motion）；普通 Claw 先校验 config 存在——
  // 目标不存在/配置损坏/未知 I/O 显式失败，不当空技能目录
  const target = opts.claw ?? MOTION_CLAW_ID;
  deps.rootConfig.loadGlobal();
  const isMotion = target === MOTION_CLAW_ID;
  if (!isMotion && deps.rootConfig.loadClaw(getClawConfigPath(target)) === undefined) {
    throw new CliError(`Claw "${target}" does not exist`);
  }
  const baseDir = isMotion ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(target);
  const registry = await createSkillSystem(deps.fsFactory(baseDir), SKILLS_DIR_DEFAULT, noopAuditLog);
  process.stdout.write(registry.formatForContext());
}
