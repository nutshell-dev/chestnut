/**
 * @module L6.CLI.Claw.Ls
 *
 * Phase 1480：列 claw clawspace 内容（与 read/import 配套）。
 *
 * 形态：`chestnut claw <name> ls [path] [--recursive] [--json]`
 *
 * 应然边界：
 * - clawDir-scoped fs（不能 escape `..`）
 * - 不传 path → 列 clawspace 根
 * - --recursive 透传 FileSystem.list({recursive:true})
 * - --json → JSON-stringify FileEntry[]、含 mtime ISO / size / isDirectory
 * - 人读 → `<size>\t<mtime ISO>\t<name>[/]`、目录后加 `/`
 *
 * 错误形态（编码规范 错误显式）：
 * - unknown claw → CliError "Claw \"X\" does not exist"
 * - path escape (resolveWorkspacePath 返 `..` / `/` 起头) → CliError
 * - fs.list throws → CliError 包装
 */

import * as path from 'path';
import { formatErr } from "../../foundation/node-utils/index.js";
import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { resolveWorkspacePath } from '../../foundation/file-tool/index.js';
import { CliError } from '../errors.js';
import { IMPORT_CLAIM_FILE, importVisibility, probeImportClaim } from './claw-import.js';
import type { FileEntry } from '../../foundation/fs/index.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

interface LsOptions {
  recursive?: boolean;
  json?: boolean;
}

interface LsEntryView {
  name: string;
  path: string;
  size: number;
  mtime: string;
  isDirectory: boolean;
  /** Phase 1913 Step B：未提交 import 目标注解（可观察的非已发布结果）。 */
  importInProgress?: boolean;
}

function toView(e: FileEntry, unpublishedDirs: ReadonlySet<string>): LsEntryView {
  return {
    name: e.name,
    path: e.path,
    size: e.size,
    mtime: e.mtime.toISOString(),
    isDirectory: e.isDirectory,
    ...(unpublishedDirs.has(e.path) ? { importInProgress: true } : {}),
  };
}

function formatHuman(entries: readonly LsEntryView[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map(
    (e) => `${String(e.size).padStart(8)}\t${e.mtime}\t${e.name}${e.isDirectory ? '/' : ''}` +
      (e.importInProgress === true ? ' (import in progress)' : ''),
  );
  return lines.join('\n') + '\n';
}

export async function lsCommand(
  deps: ClawCommandDeps,
  clawName: string,
  subPath: string | undefined,
  options: LsOptions = {},
): Promise<void> {
  deps.rootConfig.loadGlobal();

  const configPath = getClawConfigPath(clawName);
  // undefined 才是 missing；parse/corrupt/IO 异常原实例 fail-loud 上抛，不 catch。
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
    throw new CliError(`Claw "${clawName}" does not exist`);
  }

  const clawDir = getClawDir(clawName);
  const workspaceDir = path.join(clawDir, CLAWSPACE_DIR);
  const fs = deps.fsFactory(clawDir);

  const requested = subPath ?? '.';
  const resolved = resolveWorkspacePath({ clawDir, workspaceDir }, requested);
  if (resolved.startsWith('..') || resolved.startsWith('/')) {
    throw new CliError(`Path escapes claw directory: "${requested}"`);
  }

  // Phase 1913 Step B（RACE-PUBLISH-PRECOMMIT-VISIBILITY）：读侧发布门控——
  // 请求路径位于未提交 import 目标（自身或祖先带 claim）→ typed not-published，
  // 不暴露半成品。
  const visibility = importVisibility(fs, resolved);
  if (visibility.state === 'in_progress') {
    throw new CliError(
      `"${requested}" is not published yet in ${clawName}/clawspace/ ` +
      `(import in progress; claim: ${visibility.claimPath})`,
    );
  }
  if (visibility.state === 'invalid') {
    throw new CliError(
      `"${requested}" has an unreadable import state in ${clawName}/clawspace/ ` +
      `(claim: ${visibility.claimPath}); inspect the evidence before retrying`,
    );
  }

  let entries: FileEntry[];
  try {
    entries = await fs.list(resolved, {
      recursive: options.recursive === true,
      includeDirs: true,
    });
  } catch (err) {
    throw new CliError(`Error listing path: ${formatErr(err)}`, { cause: err });
  }

  // Phase 1915 Step D（RACE-VISIBILITY-CHECK-TOCTOU）：普通文件系统不能提供
  // 目录树事务快照——检查与 list 是两次独立观察。list 后复验发布态：若期间
  // claim 出现/状态变化（含 ABA 后的非 published 态），本结果可能观察到未提交
  // 目录，丢弃并返回 typed unknown/retry，绝不把两次相邻观察当事务结果呈现。
  // 残余平台限制：复验之后新出现的 claim 不可检测（已声明边界，非掩盖）。
  const after = importVisibility(fs, resolved);
  if (after.state !== 'published') {
    throw new CliError(
      `"${requested}" import state changed while listing in ${clawName}/clawspace/ ` +
      `(now ${after.state}; claim: ${after.claimPath}); result discarded — retry`,
    );
  }

  // 子级未提交 import 目标：目标目录本身注解保留（可观察），其内部条目
  // （半成品内容）从结果剔除。claim 探测类型化（Phase 1915 Step D）：
  // 未知 I/O fail-closed，不把「不可访问」当无 claim 列出半成品。
  const unpublishedDirs = new Set<string>();
  for (const e of entries) {
    if (!e.isDirectory) continue;
    const probe = probeImportClaim(fs, `${e.path}/${IMPORT_CLAIM_FILE}`);
    if (probe === 'unknown') {
      throw new CliError(
        `Clawspace entry "${e.path}" has an unreadable import state in ${clawName}/clawspace/ ` +
        `(claim: ${e.path}/${IMPORT_CLAIM_FILE}); inspect the evidence before retrying`,
      );
    }
    if (probe === 'present') {
      unpublishedDirs.add(e.path);
    }
  }
  if (unpublishedDirs.size > 0) {
    entries = entries.filter((e) =>
      [...unpublishedDirs].every((d) => e.path === d || !e.path.startsWith(`${d}/`)),
    );
  }

  // Stable sort: directories first, then alphabetical.
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const views = entries.map((e) => toView(e, unpublishedDirs));

  if (options.json === true) {
    process.stdout.write(JSON.stringify(views, null, 2) + '\n');
    return;
  }

  process.stdout.write(formatHuman(views));
}
