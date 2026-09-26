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
import { newShortUuid, sha256Hex } from '../../foundation/node-utils/index.js';
import { isAlive, getProcessStartTime, makeProcessStartTime } from '../../foundation/process-exec/index.js';
import { isFileNotFound, type FileSystem, type StatInfo } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { copyDir, type CopyStats } from '../utils/copy-dir.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

/** import 提交态 claim 文件名（owner 单一定义，读侧门控共用）。 */
export const IMPORT_CLAIM_FILE = '.import-claim';

/**
 * clawspace 内 import 目标的发布态（Phase 1913 Step B，
 * RACE-PUBLISH-PRECOMMIT-VISIBILITY）。
 * - published：路径及其祖先无 import claim——完整已提交版本或普通用户内容；
 * - in_progress：claim 在 = 落位/sweep/身份复核未完成，读者不得当已发布资源；
 * - invalid：claim 在但不可解析——证据状态未知，fail-closed。
 * 单向事实可从磁盘重建：claim 只在全部文件落位 + sweep + 占位身份复核后删除。
 */
export type ClawspaceImportVisibility =
  | { readonly state: 'published' }
  | { readonly state: 'in_progress'; readonly claimPath: string }
  | { readonly state: 'invalid'; readonly claimPath: string; readonly reason: string };

/**
 * 类型化 claim 探测（Phase 1915 Step D，RACE-IMPORT-VISIBILITY-ERROR-FAILOPEN）：
 * `existsSync` 布尔接口无法区分「不存在」与「不可访问」（Node fs.existsSync
 * 对 EACCES/EIO 等也返回 false = fail-open）；改用 statSync 类型化错误：
 * - absent：ENOENT/ENOTDIR（路径分量是文件时 claim 不可能存在）；
 * - present：claim 文件在；
 * - unknown：其余 I/O 错误——读者必须 fail-closed，不得当 published。
 */
export type ImportClaimProbe = 'absent' | 'present' | 'unknown';
export function probeImportClaim(fs: FileSystem, claimRel: string): ImportClaimProbe {
  try {
    fs.statSync(claimRel);
    return 'present';
  } catch (err) {
    if (isFileNotFound(err)) return 'absent';
    if ((err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return 'absent';
    return 'unknown';
  }
}

/**
 * owner 发布态查询入口（claw ls/read 等普通消费者只经此入口判发布态，
 * 不自行扫描「看起来是否完整」）。
 *
 * @param fs clawDir-scoped FileSystem
 * @param clawDirRelPath resolveWorkspacePath 返回的 clawDir 相对路径；
 *   沿路径自身与 clawspace 内各祖先目录查 import claim。
 */
export function importVisibility(fs: FileSystem, clawDirRelPath: string): ClawspaceImportVisibility {
  const normalized = clawDirRelPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === '' || normalized === '.' || normalized === CLAWSPACE_DIR) {
    return { state: 'published' };
  }
  const segs = normalized.split('/');
  // claim 只可能出现在 clawspace/<target…>/<srcName>/ 级；从该级起逐级查
  // （含路径自身：自身是未提交目标目录时也要命中）。
  const start = segs[0] === CLAWSPACE_DIR ? 2 : 1;
  for (let i = start; i <= segs.length; i++) {
    const dir = segs.slice(0, i).join('/');
    const claimRel = `${dir}/${IMPORT_CLAIM_FILE}`;
    // Phase 1915 Step D：类型化探测——未知 I/O fail-closed 为 invalid，
    // 不再把「不可访问」当「无 claim = published」。
    const probe = probeImportClaim(fs, claimRel);
    if (probe === 'unknown') {
      return { state: 'invalid', claimPath: claimRel, reason: 'claim probe I/O error' };
    }
    if (probe === 'absent') continue;
    let raw: string;
    try {
      raw = fs.readSync(claimRel);
    } catch (err) {
      // 探测与读取之间 claim 被删（提交完成的并发窗口）→ 按缺席继续向上查
      if (isFileNotFound(err)) continue;
      return { state: 'invalid', claimPath: claimRel, reason: `claim unreadable: ${formatErr(err)}` };
    }
    try {
      JSON.parse(raw);
      return { state: 'in_progress', claimPath: claimRel };
    } catch {
      // silent: claim 存在但不可解析 → 归 typed invalid 状态交消费者 fail-closed 呈现
      return { state: 'invalid', claimPath: claimRel, reason: 'claim malformed' };
    }
  }
  return { state: 'published' };
}

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
    // Phase 1912 Step D：带 claim 的目录目标不再即时拒绝——交由下方目录分支
    // 做死 holder 恢复判读（同 payload 续传 / 活 holder·异 payload 冲突留证）；
    // 用户既有目标（无 claim）拒绝语义不变。
    // Phase 1915 Step D：claim 探测类型化——未知 I/O fail-closed，不把
    // 「不可访问」当「无 claim = 用户既有目标」。
    const claimRelTop = `${relFromClawspace}/${IMPORT_CLAIM_FILE}`;
    const topProbe = probeImportClaim(clawspaceFs, claimRelTop);
    if (topProbe === 'unknown') {
      throw new CliError(
        `"${displayRel}" has an unreadable import state in ${clawName}/clawspace/ ` +
        `(claim: ${claimRelTop}); inspect the evidence before retrying`,
      );
    }
    const hasClaim = existing.isDirectory && topProbe === 'present';
    if (!hasClaim) {
      throw new CliError(`"${displayRel}" already exists in ${clawName}/clawspace/`);
    }
  }

  if (srcStat.isDirectory) {
    // Phase 1911 Step E + 1912 Step D（RACE-CLAW-IMPORT-EMPTY-TARGET-REPLACE /
    // RACE-CLAW-IMPORT-EMPTY-PLACEHOLDER）：占位 + no-replace 逐文件落位协议。
    // 目标路径全程由本调用占有，任何阶段都不替换外部字节：
    //   1. mkdirExclusiveSync(srcName) —— 占有裁决点；任何已存在目标（文件/
    //      空目录/非空目录）→ typed 冲突，目标原样保留；
    //   2. claim `<target>/.import-claim`（token+pid+startTime+source）——
    //      中断窗口可区分「中断的 import」与「用户既有目录」，死 holder 可判；
    //   3. 隐藏 staging 复制并计算 manifest（每文件 bytes+sha256，manifestHash
    //      写回 claim）——source 快照事实；
    //   4. 逐文件 linkExclusiveSync no-replace 落位：EEXIST → hash 判同收敛
    //      （恢复续传）/ 异内容冲突留证；rename 从不再接触目标路径；
    //   5. 落位后扫描目标必须恰含 manifest 文件 + claim（外部混入 → 冲突）；
    //   6. 复核 claim 身份（占位被外部删重建 → claim 丢失 → 冲突留证）；
    //   7. 删 claim = 提交；清 staging。claim 缺席即已提交（单向事实）。
    // 死 holder 恢复：同 manifestHash 幂等续传；异 payload 显式冲突不覆盖。
    const destParentFs = deps.fsFactory(destParent);
    await destParentFs.ensureDir('.');
    const claimRel = `${srcName}/${IMPORT_CLAIM_FILE}`;
    const stageName = `.import-staging-${newShortUuid()}`;
    const myToken = newShortUuid();

    interface ImportClaim {
      token: string;
      pid?: number;
      process_start_time?: string;
      createdAt: string;
      source: string;
      target: string;
      manifestHash?: string;
    }
    interface ImportManifestEntry { path: string; bytes: number; sha256: string }

    const writeClaim = (manifestHash?: string): void => {
      destParentFs.writeAtomicSync(claimRel, JSON.stringify({
        token: myToken,
        pid: process.pid,
        process_start_time: getProcessStartTime(process.pid),
        createdAt: new Date().toISOString(),
        source: srcAbs,
        target: displayRel,
        ...(manifestHash !== undefined ? { manifestHash } : {}),
      } satisfies ImportClaim, null, 2));
    };

    const readClaim = (): ImportClaim => {
      let claim: ImportClaim;
      try {
        claim = JSON.parse(destParentFs.readSync(claimRel)) as ImportClaim;
      } catch {
        throw new CliError(
          `"${displayRel}" import is already in progress or was interrupted in ${clawName}/clawspace/ ` +
          `(claim evidence: ${claimRel}); inspect and remove it to retry`,
        );
      }
      // holder 活性：证死才允许接管；探测不确定 → fail-closed 视为进行中
      const holderAlive = typeof claim.pid === 'number'
        ? isAlive(claim.pid, typeof claim.process_start_time === 'string' && claim.process_start_time !== ''
          ? makeProcessStartTime(claim.process_start_time)
          : undefined)
        : undefined;
      if (holderAlive !== false) {
        throw new CliError(
          `"${displayRel}" import is already in progress or was interrupted in ${clawName}/clawspace/ ` +
          `(claim evidence: ${claimRel}, pid=${claim.pid ?? 'unknown'}); inspect and remove it to retry`,
        );
      }
      return claim;
    };

    // 1. 占有裁决
    let resumedClaim: ImportClaim | null = null;
    try {
      destParentFs.mkdirExclusiveSync(srcName);
      writeClaim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      // 目标已存在：无 claim → 用户既有目标（拒绝语义不变）；有 claim → 恢复判读。
      // Phase 1915 Step D：claim 探测类型化——未知 I/O fail-closed。
      const leftoverProbe = probeImportClaim(destParentFs, claimRel);
      if (leftoverProbe === 'unknown') {
        throw new CliError(
          `"${displayRel}" has an unreadable import state in ${clawName}/clawspace/ ` +
          `(claim: ${claimRel}); inspect the evidence before retrying`,
        );
      }
      if (leftoverProbe === 'absent') {
        throw new CliError(`"${displayRel}" already exists in ${clawName}/clawspace/`);
      }
      resumedClaim = readClaim();
    }

    // 2. staging 复制 + manifest（源快照事实）
    try {
      await copyDir(deps, srcAbs, path.join(destParent, stageName), stats);
    } catch (err) {
      // fail-closed：保留 claim 目录 + staging 证据交 owner recovery，不静默删除
      throw new CliError(
        `Import of "${displayRel}" failed: ${formatErr(err)}; ` +
        `evidence preserved at ${path.join(destParent, srcName)} and ${path.join(destParent, stageName)}`,
      );
    }
    const stageFs = deps.fsFactory(path.join(destParent, stageName));
    const manifest: ImportManifestEntry[] = stageFs
      .listSync('.', { recursive: true })
      .filter((e) => e.isFile)
      .map((e) => ({ path: e.path, bytes: e.size, sha256: sha256Hex(stageFs.readSync(e.path)) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const manifestHash = sha256Hex(JSON.stringify(manifest));

    if (resumedClaim !== null) {
      // 死 holder 恢复判读：同 payload 幂等续传；异 payload 显式冲突留证。
      // Phase 1913 Step B（RACE-CLAW-IMPORT-RECOVERY-IDENTITY）：claim 缺
      // manifestHash = 源快照事实未持久化（首次 claim 写入与 manifest 持久化
      // 之间崩溃）——只有 source 路径相同不构成 payload identity，fail-closed
      // 交 owner 显式决策，不得把变化后的 source 当旧 intent 续传。
      if (resumedClaim.manifestHash === undefined) {
        await destParentFs.removeDir(stageName).catch(() => {
          // silent: 我方 staging 清理失败不掩盖冲突事实；残留 `.import-staging-*` 可人工删
        });
        throw new CliError(
          `"${displayRel}" has an interrupted import whose original source payload cannot be proven ` +
          `(claim ${claimRel} lacks manifestHash) in ${clawName}/clawspace/; ` +
          `evidence preserved; inspect and remove the claim to retry`,
        );
      }
      const sameIntent = resumedClaim.source === srcAbs && resumedClaim.manifestHash === manifestHash;
      if (!sameIntent) {
        await destParentFs.removeDir(stageName).catch(() => {
          // silent: 我方 staging 清理失败不掩盖冲突事实；残留 `.import-staging-*` 可人工删
        });
        throw new CliError(
          `"${displayRel}" has an interrupted import with a different source payload in ${clawName}/clawspace/ ` +
          `(claim: ${claimRel}, source: ${resumedClaim.source}); evidence preserved, not overwritten`,
        );
      }
    }
    writeClaim(manifestHash);

    // 3. 逐文件 no-replace 落位（恢复重跑按 hash 收敛）
    for (const entry of manifest) {
      const destRel = `${srcName}/${entry.path}`;
      const stagedRel = `${stageName}/${entry.path}`;
      try {
        destParentFs.linkExclusiveSync(stagedRel, destRel);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        // 已落位：同 hash = 本方/并发同 intent 已提交 → 收敛；异内容 → 冲突留证
        const destContent = await destParentFs.read(destRel).catch(() => null);
        if (destContent === null || sha256Hex(destContent) !== entry.sha256) {
          throw new CliError(
            `"${displayRel}" target file "${entry.path}" exists with different bytes in ${clawName}/clawspace/; ` +
            `conflict — evidence preserved, not overwritten`,
          );
        }
      }
    }

    // 4. 外部混入扫描：目标必须恰含 manifest 文件 + claim
    // （listSync 的 e.path 相对 destParentFs baseDir，故带 srcName 前缀）
    const expected = new Set([...manifest.map((e) => `${srcName}/${e.path}`), claimRel]);
    const actualFiles = destParentFs
      .listSync(srcName, { recursive: true })
      .filter((e) => e.isFile)
      .map((e) => e.path);
    const extra = actualFiles.filter((p) => !expected.has(p));
    if (extra.length > 0) {
      throw new CliError(
        `"${displayRel}" claim directory was modified during import in ${clawName}/clawspace/ ` +
        `(unexpected: ${extra.join(', ')}); conflict — evidence preserved at ${path.join(destParent, srcName)}`,
      );
    }

    // 5. 占位身份复核（被外部删重建 → claim 丢失/token 不符 → 冲突留证）
    const finalClaimRaw = await destParentFs.read(claimRel).catch(() => null);
    if (finalClaimRaw === null || (JSON.parse(finalClaimRaw) as ImportClaim).token !== myToken) {
      throw new CliError(
        `"${displayRel}" placeholder identity was lost during import in ${clawName}/clawspace/; ` +
        `conflict — evidence preserved at ${path.join(destParent, srcName)}`,
      );
    }

    // 6. 提交：删 claim（claim 缺席即已提交）+ 清 staging
    destParentFs.deleteSync(claimRel);
    await destParentFs.removeDir(stageName).catch(() => {
      // silent: staging 清理失败不影响已提交事实；残留 `.import-staging-*` 可人工删
    });

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
