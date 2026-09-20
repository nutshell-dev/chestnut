/**
 * @module L2b.DialogStore.SessionFileQuery
 * session 文件读取查询（0-instance-dep 只读；phase 1879 Step C，cli-subagent-layout-probing 收口）。
 *
 * 背景：CLI session-parser 曾以 `JSON.parse(fs.readSync(...))` 直读 dialog 文件 +
 * 自行枚举 `<dir>/archive/` 选最新归档——「当前/归档两态、归档命名（{ts}_*.json）、
 * 版本裁决」的布局/格式理解泄漏在 CLI。本查询把这些收口回 DialogStore owner
 * （形态同 1872 D/E 的 0-instance-dep 窄查询；listArchiveDialogFiles 的同步只读变体族）。
 *
 * 语义（与迁移前 CLI 内联实现逐语义等价）：
 * - current 存在 → 读 + parseSessionData（版本裁决/迁移归 owner 唯一入口）；
 * - current 缺失 → `<dirname>/archive/` 下最新 `{ts}_*.json`（`^\d+_` 前缀、ts 降序首个）；
 * - 文件缺失不算错误：`not_found`（带 archiveDirExists 区分「archive 目录也没有」/
 *   「archive 为空」两态，错误文案由 caller 呈现层组合）；
 * - JSON.parse 失败 / I/O 错误原样上抛（读取未知 ≠ 不存在）；
 * - parseSessionData rejected → `rejected`（版本过高/形状非法），不隔离不修复。
 *
 * 只读：不做 corruption 隔离（那是 DialogStore 实例 loadStable 的写侧语义）、不写 audit、
 * 不构造 DialogStore 实例；subagent messages.json 等非 claw dialog 路径同样适用
 * （filePath 任意——归档协议只看同目录 archive/ 子目录）。
 */
import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { DIALOG_ARCHIVE_SUBDIR } from './dirs.js';
import { parseSessionData } from './validate.js';
import type { SessionData } from './types.js';

export type SessionFileLoadOutcome =
  | { kind: 'ok'; session: SessionData; source: 'current' }
  | { kind: 'ok'; session: SessionData; source: 'archive'; archiveName: string }
  | { kind: 'not_found'; archiveDirExists: boolean }
  | { kind: 'rejected'; source: 'current' }
  | { kind: 'rejected'; source: 'archive'; archiveName: string };

/**
 * 读取 session 文件（current 优先、archive 最新回落）。
 * @param fs 任意 root 的 FileSystem（filePath 为绝对/相对均可，fs 内部解析）
 * @param filePath 目标 session 文件（如 <clawDir>/dialog/current.json、<resultDir>/messages.json）
 */
export function loadSessionFile(fs: FileSystem, filePath: string): SessionFileLoadOutcome {
  if (fs.existsSync(filePath)) {
    const outcome = parseSessionData(JSON.parse(fs.readSync(filePath)), path.basename(filePath));
    if (outcome.kind !== 'ok') return { kind: 'rejected', source: 'current' };
    return { kind: 'ok', session: outcome.session, source: 'current' };
  }

  const archiveDir = path.join(path.dirname(filePath), DIALOG_ARCHIVE_SUBDIR);
  if (!fs.existsSync(archiveDir)) return { kind: 'not_found', archiveDirExists: false };
  const latestArchive = findLatestArchive(fs, archiveDir);
  if (latestArchive === null) return { kind: 'not_found', archiveDirExists: true };

  const outcome = parseSessionData(JSON.parse(fs.readSync(path.join(archiveDir, latestArchive))), latestArchive);
  if (outcome.kind !== 'ok') return { kind: 'rejected', source: 'archive', archiveName: latestArchive };
  return { kind: 'ok', session: outcome.session, source: 'archive', archiveName: latestArchive };
}

/** archive 目录内最新 `{ts}_*.json`（`^\d+_` 前缀、ts 降序首个；无匹配 null）。 */
function findLatestArchive(fs: FileSystem, archiveDir: string): string | null {
  const entries = fs.listSync(archiveDir);
  const archives = entries
    .filter((e) => e.isFile && e.name.endsWith('.json') && /^\d+_/.test(e.name))
    .map((e) => ({ name: e.name, ts: parseInt(e.name.split('_')[0], 10) }))
    .filter((a) => !isNaN(a.ts))
    .sort((a, b) => b.ts - a.ts);
  return archives.length > 0 ? archives[0].name : null;
}
