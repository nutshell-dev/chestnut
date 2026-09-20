/**
 * @module L6.Watchdog.Quarantine
 *
 * Phase 1878 Step F/G：损坏资源隔离 helper（Watchdog 本地，evidence 文件与
 * state 条目共用形态）。
 *
 * 语义：原文重命名为 `.<id>.corrupt-<ts>` 保留（DP 信息不丢——不删除任何
 * 损坏原文），返回 typed 结果供 caller 审计；隔离文件清理策略另议（保留优先）。
 */
import type { FileSystem } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';

export type QuarantineResult =
  | { kind: 'quarantined'; backupPath: string }
  | { kind: 'failed'; backupPath: string; error: string };

/** 把 targetPath 原文隔离为 `${targetPath}.corrupt-${now}`（move 失败不抛、typed 返回）。 */
export function quarantineCorruptFile(
  fs: FileSystem,
  targetPath: string,
  now: number,
): QuarantineResult {
  const backupPath = `${targetPath}.corrupt-${now}`;
  try {
    fs.moveSync(targetPath, backupPath);
    return { kind: 'quarantined', backupPath };
  } catch (err) {
    return { kind: 'failed', backupPath, error: formatErr(err) };
  }
}
