/**
 * @module L6.CLI.Claw.Ls
 *
 * Phase 1480：列 claw clawspace 内容（与 read/import 配套）。
 *
 * 形态：`clawforum claw <name> ls [path] [--recursive] [--json]`
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
import { loadGlobalConfig, clawExists, getClawDir } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { CLAWSPACE_DIR } from '../../foundation/paths.js';
import { resolveWorkspacePath } from '../../foundation/file-tool/resolve-path.js';
import { CliError } from '../errors.js';
import type { FileSystem, FileEntry } from '../../foundation/fs/types.js';

export interface LsOptions {
  recursive?: boolean;
  json?: boolean;
}

interface LsEntryView {
  name: string;
  path: string;
  size: number;
  mtime: string;
  isDirectory: boolean;
}

function toView(e: FileEntry): LsEntryView {
  return {
    name: e.name,
    path: e.path,
    size: e.size,
    mtime: e.mtime.toISOString(),
    isDirectory: e.isDirectory,
  };
}

function formatHuman(entries: readonly LsEntryView[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map(
    (e) => `${String(e.size).padStart(8)}\t${e.mtime}\t${e.name}${e.isDirectory ? '/' : ''}`,
  );
  return lines.join('\n') + '\n';
}

export async function lsCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawName: string,
  subPath: string | undefined,
  options: LsOptions = {},
): Promise<void> {
  loadGlobalConfig(deps, CONFIG_DEFAULTS);

  if (!clawExists(deps, clawName)) {
    throw new CliError(`Claw "${clawName}" does not exist`);
  }

  const clawDir = getClawDir(clawName);
  const workspaceDir = path.join(clawDir, CLAWSPACE_DIR);
  const fs = deps.fsFactory(clawDir);

  const requested = subPath ?? '.';
  const miniCtx = { clawDir, workspaceDir } as { clawDir: string; workspaceDir: string };
  const resolved = resolveWorkspacePath(miniCtx as never, requested);
  if (resolved.startsWith('..') || resolved.startsWith('/')) {
    throw new CliError(`Path escapes claw directory: "${requested}"`);
  }

  let entries: FileEntry[];
  try {
    entries = await fs.list(resolved, {
      recursive: options.recursive === true,
      includeDirs: true,
    });
  } catch (err) {
    throw new CliError(`Error listing path: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Stable sort: directories first, then alphabetical.
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const views = entries.map(toView);

  if (options.json === true) {
    process.stdout.write(JSON.stringify(views, null, 2) + '\n');
    return;
  }

  process.stdout.write(formatHuman(views));
}
