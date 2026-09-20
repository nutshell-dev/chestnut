/**
 * @module L6.Assembly.SubagentResultQuery
 * subagent 结果目录解析（跨 owner 组合查询；phase 1879 Step C，
 * cli-subagent-layout-probing 收口）。
 *
 * 背景：CLI `subagent steps <id>` 的 resolveResultDir 曾对三命名空间
 * （ATS `tasks/queues/results` / SubAgent `tasks/sync/subagent` / SubAgent
 * `tasks/subagents` legacy）自行做存在性探测——布局理解泄漏在 CLI。
 *
 * 归属：三命名空间分属 ATS / SubAgent 两 owner（M#3 各自声明）；跨 owner 的
 * 组合与探测顺序归 Assembly（同 claw-subdirs.ts 聚合先例）。本入口组合两 owner
 * 查询，顺序与历史 CLI 探测逐语义等价：async（ATS）→ sync → legacy（SubAgent）。
 *
 * 只读：命中返回 clawDir 绝对路径（caller 直接消费），未命中 null。
 */
import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { resolveTaskResultDir } from '../core/async-task-system/index.js';
import { resolveSubagentRunDir } from '../core/subagent/index.js';

/** 按 id 解析 subagent 结果目录（async → sync → legacy 顺序；未命中 null）。 */
export function resolveSubagentResultDir(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawDir: string,
  id: string,
): string | null {
  const clawFs = deps.fsFactory(clawDir);
  const rel = resolveTaskResultDir(clawFs, id) ?? resolveSubagentRunDir(clawFs, id);
  return rel === null ? null : path.join(clawDir, rel);
}
