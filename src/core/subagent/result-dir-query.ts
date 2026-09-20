/**
 * @module L3.SubAgent.ResultDirQuery
 * SubAgent run 结果目录存在性查询（0-instance-dep 只读；phase 1879 Step C，
 * cli-subagent-layout-probing 收口）。
 *
 * 背景：CLI `subagent steps` 曾自行对 `tasks/sync/subagent/`（sync L4 直调）与
 * `tasks/subagents/`（legacy）两命名空间做存在性探测——SubAgent owner 的目录布局
 * 知识泄漏在 CLI。本查询把两命名空间的布局与优先级（sync 优先、legacy 次之，
 * 与历史探测顺序一致）收口回 owner（两常量 canonical owner 均为本模块，见
 * constants.ts）；布局演进只影响本文件。
 *
 * 只读：命中返回 clawDir 相对路径，未命中 null。
 */
import type { FileSystem } from '../../foundation/fs/index.js';
import { TASKS_SYNC_SUBAGENT_DIR, TASKS_SUBAGENTS_DIR } from './constants.js';

/** owner 命名空间探测顺序（sync → legacy；与历史 CLI 探测顺序一致）。 */
const SUBAGENT_RUN_DIRS = [TASKS_SYNC_SUBAGENT_DIR, TASKS_SUBAGENTS_DIR] as const;

/** 按 id 探测 subagent run 结果目录（首个命名空间命中即返回；未命中 null）。 */
export function resolveSubagentRunDir(
  fs: Pick<FileSystem, 'existsSync'>,
  id: string,
): string | null {
  for (const dir of SUBAGENT_RUN_DIRS) {
    const rel = `${dir}/${id}`;
    if (fs.existsSync(rel)) return rel;
  }
  return null;
}
