/**
 * @module L6.CLI.Claw.Import
 * Import local files/directories into a Claw's clawspace.
 *
 * Phase 1472 Step B：从 `cp` 重命名为 `import` —— `cp` 沿用 unix 双参数对称隐喻
 * 与本命令实然单向「塞文件进 claw」语义不符。改 `import` 后单参数 `<source>`
 * 自洽、方向自解释、未来加反向 `export` 自然对称。
 */

import * as path from 'path';
import { loadGlobalConfig, clawExists } from '../../assembly/config/config-load.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { CliError } from '../errors.js';
import type { FileSystem, StatInfo } from '../../foundation/fs/index.js';
import { copyDir, type CopyStats } from '../utils/copy-dir.js';

async function tryStat(fs: FileSystem, p: string): Promise<StatInfo | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

export async function importCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  source: string,
  clawName: string,
  target?: string,
): Promise<void> {
  loadGlobalConfig(deps);

  const configPath = getClawConfigPath(clawName);
  if (!clawExists(deps, configPath)) {
    throw new CliError(`Claw "${clawName}" does not exist`);
  }

  const srcAbs = path.resolve(source);
  const srcParentDir = path.dirname(srcAbs);
  const srcName = path.basename(srcAbs);
  const srcParentFs = deps.fsFactory(srcParentDir);

  // Check source exists
  const srcStat = await tryStat(srcParentFs, srcName);
  if (!srcStat) {
    throw new CliError(`"${source}" does not exist`);
  }

  const clawDir = getClawDir(clawName);
  const clawspaceDir = path.join(clawDir, CLAWSPACE_DIR);
  const stats: CopyStats = { files: 0, dirs: 0, bytes: 0 };

  // Resolve destination: clawspace/<target?>/<srcName>
  const displayRel = target ? `${target}/${srcName}` : srcName;
  const destParent = target ? path.join(clawspaceDir, target) : clawspaceDir;
  const destPath = path.join(destParent, srcName);

  // Guard against path traversal
  const relFromClawspace = path.relative(clawspaceDir, destPath);
  if (relFromClawspace.startsWith('..') || path.isAbsolute(relFromClawspace)) {
    throw new CliError(`Invalid target: "${target}" escapes clawspace`);
  }

  // Check if target already exists in clawspace
  const clawspaceFs = deps.fsFactory(clawspaceDir);
  const existing = await tryStat(clawspaceFs, relFromClawspace);
  if (existing) {
    throw new CliError(`"${displayRel}" already exists in ${clawName}/clawspace/`);
  }

  if (srcStat.isDirectory) {
    await copyDir(deps, srcAbs, destPath, stats);
    const sizeStr = stats.bytes >= 1024
      ? `${(stats.bytes / 1024).toFixed(1)} KB`
      : `${stats.bytes} B`;
    console.log(`✓ Copied to ${clawName}/clawspace/${displayRel}/`);
    console.log(`  ${stats.files} files, ${stats.dirs} dirs, ${sizeStr}`);
  } else {
    // Single file
    const destParentFs = deps.fsFactory(destParent);
    await destParentFs.ensureDir('.');
    const content = await srcParentFs.read(srcName);
    await destParentFs.writeAtomic(srcName, content);
    stats.files = 1;
    stats.bytes = Buffer.byteLength(content, 'utf-8');
    const sizeStr = stats.bytes >= 1024
      ? `${(stats.bytes / 1024).toFixed(1)} KB`
      : `${stats.bytes} B`;
    console.log(`✓ Copied to ${clawName}/clawspace/${displayRel}`);
    console.log(`  1 file, ${sizeStr}`);
  }
}
