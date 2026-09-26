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
    // Phase 1911 Step E：区分中断 import 的 claim 残留（证据路径可操作）与
    // 用户既有目标（拒绝语义不变）
    if (existing.isDirectory) {
      const leftover = await tryStat(clawspaceFs, `${relFromClawspace}/.import-claim`);
      if (leftover) {
        throw new CliError(
          `"${displayRel}" import is already in progress or was interrupted in ${clawName}/clawspace/ ` +
          `(claim evidence: ${relFromClawspace}/.import-claim); inspect and remove it to retry`,
        );
      }
    }
    throw new CliError(`"${displayRel}" already exists in ${clawName}/clawspace/`);
  }

  if (srcStat.isDirectory) {
    // Phase 1911 Step E（RACE-CLAW-IMPORT-EMPTY-TARGET-REPLACE）：no-replace
    // 目录发布协议。POSIX/Node 无 rename-no-replace flag，唯一原子「路径不存在
    // 才成功」的目录原语是 mkdir —— 因此目标路径本身先被 mkdir 独占（空目录
    // 亦冲突），复制仍在隐藏 staging 进行，发布前核验 claim 未被外部写入，
    // 最后 rename 替换的是我们自己的空 claim 目录：
    //   1. mkdirExclusiveSync(srcName) —— 提交裁决点；任何已存在目标
    //      （文件/空目录/非空目录）→ typed 冲突，目标原样保留；
    //   2. claim 内写 `<target>/.import-claim`（token）—— 崩溃窗口可区分
    //      「中断的 import claim」与「用户既有目录」；
    //   3. 隐藏 staging 复制；读失败保留 claim+staging 证据，不触碰目标；
    //   4. 发布前核验 claim 目录仍只含我们的 claim 文件（外部写入 → 冲突留证）；
    //   5. 删 claim 文件 → rename staging 替换我们的空 claim 目录；目标在
    //      核验后一旦被写入任何内容，rename 必失败（ENOTEMPTY）→ 冲突留证。
    // 已知残余：删空 claim 目录与 rename 之间为相邻系统调用窗口，外部恰好
    // 重建空目录才会被替换 —— 损失仅限空占位目录，无用户数据；完整 copy
    // 窗口（秒级）已由 mkdir 独占完全关闭。
    const destParentFs = deps.fsFactory(destParent);
    await destParentFs.ensureDir('.');
    const claimRel = `${srcName}/.import-claim`;
    const stageName = `.import-staging-${newShortUuid()}`;
    const myToken = newShortUuid();
    try {
      destParentFs.mkdirExclusiveSync(srcName);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        // pre-check 后目标才出现：区分中断 claim 残留与用户既有目标（不自动清理）
        const leftover = await tryStat(destParentFs, claimRel);
        if (leftover) {
          throw new CliError(
            `"${displayRel}" import is already in progress or was interrupted in ${clawName}/clawspace/ ` +
            `(claim evidence: ${claimRel}); inspect and remove it to retry`,
          );
        }
        throw new CliError(`"${displayRel}" already exists in ${clawName}/clawspace/`);
      }
      throw err;
    }
    destParentFs.writeExclusiveSync(claimRel, JSON.stringify({
      token: myToken,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      source: srcAbs,
      target: displayRel,
    }, null, 2));
    try {
      await copyDir(deps, srcAbs, path.join(destParent, stageName), stats);
      // 发布前核验：claim 目录仍只含我们的 claim 文件（外部写入 → 显式冲突）
      const claimEntries = destParentFs.listSync(srcName).map((e) => e.name).sort();
      const claimRaw = destParentFs.readSync(claimRel);
      const claimToken = (JSON.parse(claimRaw) as { token?: string }).token;
      if (claimEntries.length !== 1 || claimEntries[0] !== '.import-claim' || claimToken !== myToken) {
        throw new CliError(
          `"${displayRel}" claim directory was modified during import in ${clawName}/clawspace/; ` +
          `conflict — target left untouched, evidence preserved at ${path.join(destParent, srcName)}`,
        );
      }
      destParentFs.deleteSync(claimRel);
      await destParentFs.moveDir(stageName, srcName);
    } catch (err) {
      if (err instanceof CliError) throw err;
      // fail-closed：保留 claim 目录 + staging 证据交 owner recovery，不静默删除
      throw new CliError(
        `Import of "${displayRel}" failed: ${formatErr(err)}; ` +
        `evidence preserved at ${path.join(destParent, srcName)} and ${path.join(destParent, stageName)}`,
      );
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
