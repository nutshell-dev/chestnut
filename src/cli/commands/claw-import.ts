/**
 * @module L6.CLI.Claw.Import
 * Import local files/directories into a Claw's clawspace.
 *
 * Phase 1472 Step B：从 `cp` 重命名为 `import` —— `cp` 沿用 unix 双参数对称隐喻
 * 与本命令实然单向「塞文件进 claw」语义不符。改 `import` 后单参数 `<source>`
 * 自洽、方向自解释、未来加反向 `export` 自然对称。
 */

import * as path from 'path';
import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { CliError } from '../errors.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { newShortUuid } from '../../foundation/node-utils/index.js';
import type { FileSystem, StatInfo } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { copyDir, type CopyStats } from '../utils/copy-dir.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

async function tryStat(fs: FileSystem, p: string): Promise<StatInfo | null> {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

export async function importCommand(
  deps: ClawCommandDeps,
  source: string,
  clawName: string,
  target?: string,
  opts?: { audit?: AuditLog },
): Promise<void> {
  deps.rootConfig.loadGlobal();

  const configPath = getClawConfigPath(clawName);
  if (deps.rootConfig.loadClaw(configPath) === undefined) {
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
    // Phase 1910 Step F（RACE-CLAW-IMPORT-TARGET-CHECK）：目录级目标占有 +
    // staging 发布协议，替代 check-then-copy：
    //   1. O_EXCL claim（`.<name>.importing`）——同一目标只有一次 import 占有，
    //      并发/中断残留立即 typed 冲突并保留证据；
    //   2. 复制进唯一 staging 目录（同文件系统根内）；读失败保留 staging+claim，
    //      不触碰已存在目标；
    //   3. 同根 rename 原子发布；目标中途出现（非空）→ rename 失败 → 显式冲突，
    //      不覆盖。
    const destParentFs = deps.fsFactory(destParent);
    await destParentFs.ensureDir('.');
    const claimName = `.${srcName}.importing`;
    const stageName = `.import-staging-${newShortUuid()}`;
    try {
      destParentFs.writeExclusiveSync(claimName, JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        source: srcAbs,
        target: displayRel,
      }, null, 2));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new CliError(
          `"${displayRel}" import already in progress or was interrupted in ${clawName}/clawspace/ ` +
          `(claim: ${claimName}); inspect the claim/staging evidence and remove it to retry`,
        );
      }
      throw err;
    }
    try {
      await copyDir(deps, srcAbs, path.join(destParent, stageName), stats);
      await destParentFs.moveDir(stageName, srcName);
    } catch (err) {
      // fail-closed：保留 staging + claim 证据交 owner recovery，不静默删除未完成事实
      throw new CliError(
        `Import of "${displayRel}" failed: ${formatErr(err)}; ` +
        `evidence preserved at ${path.join(destParent, stageName)} and ${path.join(destParent, claimName)}`,
      );
    }
    try {
      destParentFs.deleteSync(claimName);
    } catch (err) {
      // best-effort：claim 释放失败不影响已发布事实，残留按中断证据由 owner recovery 处理
      console.warn(`Warning: failed to release import claim ${claimName}: ${formatErr(err)}`);
    }
    const sizeStr = stats.bytes >= 1024
      ? `${(stats.bytes / 1024).toFixed(1)} KB`
      : `${stats.bytes} B`;
    console.log(`✓ Copied to ${clawName}/clawspace/${displayRel}/`);
    console.log(`  ${stats.files} files, ${stats.dirs} dirs, ${sizeStr}`);
  } else {
    // Single file —— Phase 1910 Step F：O_EXCL 独占写即目标占有 + 发布提交，
    // 同名并发 import 只有一个 winner。
    const destParentFs = deps.fsFactory(destParent);
    await destParentFs.ensureDir('.');
    const content = await srcParentFs.read(srcName);
    try {
      destParentFs.writeExclusiveSync(srcName, content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new CliError(`"${displayRel}" already exists in ${clawName}/clawspace/`);
      }
      throw err;
    }
    stats.files = 1;
    stats.bytes = Buffer.byteLength(content, 'utf-8');
    const sizeStr = stats.bytes >= 1024
      ? `${(stats.bytes / 1024).toFixed(1)} KB`
      : `${stats.bytes} B`;
    console.log(`✓ Copied to ${clawName}/clawspace/${displayRel}`);
    console.log(`  1 file, ${sizeStr}`);
  }
  // phase 1452 Step B: 成功侧 emit（落盘后）；失败侧走既有 CliError/handler catch
  opts?.audit?.write(CLI_AUDIT_EVENTS.CLAW_IMPORT, `claw=${clawName}`, `target=${displayRel}`);
}
