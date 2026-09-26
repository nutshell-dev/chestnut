/**
 * Skill install commands
 *
 * User mode: install skill from local path to workspace
 * Internal mode: install dispatch-skill to a specific claw
 *
 * Phase 1911 Step G（RACE-CLI-SKILL-MULTIROOT-COPY）+ Phase 1915 Step B
 * （RACE-SKILL-TARGET-PRECOMMIT）：初始分发 + target-local 独立提交。
 * 同一 skillName 的安装由 per-skill claim（O_EXCL durable intent）串行化：
 * - 每个目标根先复制到同父目录隐藏 staging，再以 rename 交换发布
 *   （旧版整体让位 → 新版整体落位；消费者只见完整旧版/完整新版/短暂缺失，
 *   永不见半版混合）；
 * - 每个目标副本是独立资源：自身 marker（SKILL_PUBLISH_MARKER）删除前不可
 *   消费，删除后是独立可编辑副本；intent 只承担恢复与命令结果，不是
 *   SkillSystem 的跨目标消费锁；
 * - intent 持久记录 source manifest、target set 与逐目标 state
 *   （pending → publishing → published）；崩溃后凭 intent + 目标自身
 *   marker 判定：state=published 或 publishing 且 marker 已缺席（提交完成于
 *   崩溃前）的目标绝不重写——保护 post-install 用户编辑；holder 已死且
 *   source payload 相同才自动恢复，payload 不同一律显式冲突留证；
 * - source 先 materialize 成本次安装独占的不可变快照（Phase 1915 Step C，
 *   RACE-DISPATCH-SOURCE-SNAPSHOT；foundation 约定目录前缀
 *   SKILL_SOURCE_SNAPSHOT_PREFIX）：快照 manifest 经 live source 复核自一致
 *   后才成为权威 payload（快照即 source identity，随 intent 持久化）；
 *   快照期间 source 变化 → 有界重试，仍不稳定 → fail-closed；恢复优先复用
 *   持久快照（编辑前完整版本），快照缺失且 live source 已偏离 intent
 *   payload → 显式冲突留证；
 * - 成功 audit/输出只在目标集合全部 published 后发出。
 */

import { DISPATCH_SKILLS_SUBDIR } from '../../core/evolution-system/index.js';
import { getWorkspaceRoot } from '../../foundation/claw-identity/index.js';
import * as path from 'path';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { SKILLS_DIR_DEFAULT, SKILL_PUBLISH_MARKER, SKILL_SOURCE_SNAPSHOT_PREFIX, SKILL_COMMIT_PROOF } from '../../foundation/skill-system/index.js';
import { getClawDir } from '../../foundation/claw-identity/index.js';
import { newShortUuid, sha256Hex, formatErr } from '../../foundation/node-utils/index.js';
import { isAlive, getProcessStartTime, makeProcessStartTime } from '../../foundation/process-exec/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { copyDir } from '../utils/copy-dir.js';

/* ---------- Phase 1911 Step G: durable install intent ---------- */

interface SkillSourceManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

interface SkillInstallIntent {
  // schema 2（Phase 1916 Step C）：+ id（稳定 install 身份，marker 占有证据）、
  // targets[].preState（崩溃前目标先态）、committing 状态与 commitBranch。
  schema_version: 1 | 2;
  token: string;
  /** 稳定 install 身份：holder 接管不 rewrite，写入 target marker 作占有证据。 */
  id: string;
  skillName: string;
  source: string;
  pid: number;
  process_start_time?: string;
  startedAt: string;
  manifest: SkillSourceManifestEntry[];
  /** Phase 1915 Step C：source snapshot 目录名（claim 同级隐藏目录）= 本次安装的 source identity。 */
  sourceSnapshot?: string;
  // Phase 1915 Step B：publishing = 已开始向该目标写入（崩溃窗口可区分
  // 「本 intent 已触碰该目标」与「尚未触碰」）。
  // Phase 1916 Step C：committing = 落位/swap 证据已齐、提交点进行中
  // （absent 分支：marker 删除前；existing 分支：trash rename 前）。
  targets: {
    id: string;
    state: 'pending' | 'publishing' | 'committing' | 'published';
    /** 崩溃前观察到的目标先态：'absent' 或既有目标内容 hash——recovery 身份证据。 */
    preState?: 'absent' | { contentHash: string };
    /** committing 时记录提交分支（absent=marker 删除 / existing=staging swap）。 */
    commitBranch?: 'absent' | 'existing';
  }[];
}

/** 源快照 manifest（路径+大小+内容 hash，排序确定）。源在复制期间被改属外部源快照边界。 */
function computeSkillSourceManifest(sourceFs: FileSystem): SkillSourceManifestEntry[] {
  return sourceFs
    .listSync('.', { recursive: true })
    .filter((e) => e.isFile)
    // post-commit 身份证据（SKILL_COMMIT_PROOF，仅根级）是协议工件非 payload：
    // 已提交 skill 目录作为 source/目标时必须从内容身份中排除（marker 不列入
    // 过滤——source 侧 marker 由 probe fail-closed 拒绝入场）
    .filter((e) => e.path !== SKILL_COMMIT_PROOF)
    .map((e) => ({ path: e.path, size: e.size, sha256: sha256Hex(sourceFs.readSync(e.path)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 剥掉复制结果根级的 post-commit 证据（已提交 skill 目录作 source 时证据字节
 * 会被 copyDir 带入快照/staging；它是协议工件非 payload，绝不随发布落位——
 * 缺席是常态，仅真实存在时删除）。
 */
async function stripCommitProof(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  dirAbs: string,
): Promise<void> {
  const dirFs = deps.fsFactory(dirAbs);
  await dirFs.delete(SKILL_COMMIT_PROOF).catch((err: unknown) => {
    if (isFileNotFound(err) || (err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return;
    throw err; // 未知 I/O fail-closed：证据残留会随快照/staging 污染下游目标
  });
}

/* ---------- Phase 1915 Step C: stable source snapshot ---------- */

/** source 快照物化的有界重试次数（source 在快照期间持续变化 → fail-closed）。 */
const SOURCE_SNAPSHOT_MAX_ATTEMPTS = 3;

/**
 * source 根发布态 marker 的类型化探测（Phase 1916 Step B，
 * RACE-DISPATCH-SOURCE-PROTOCOL-ARTIFACT）：marker 在 = source 发布未提交；
 * 未知 I/O 不当缺席（fail-open 会把 marker 静默复制成技能 payload）。
 */
function probeSourcePublishMarker(sourceFs: FileSystem): 'absent' | 'present' | 'unknown' {
  try {
    sourceFs.statSync(SKILL_PUBLISH_MARKER);
    return 'present';
  } catch (err) {
    if (isFileNotFound(err)) return 'absent';
    if ((err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return 'absent';
    return 'unknown';
  }
}

/**
 * 把可变 source materialize 成本次安装独占的不可变快照目录
 * （RACE-DISPATCH-SOURCE-SNAPSHOT）。
 *
 * 一致性协议（普通文件系统无目录树事务快照，两个提交点分离）：
 * 0. source 根 marker（SKILL_PUBLISH_MARKER，owner = foundation skill-system）
 *    在场 = source 发布未提交 → 重试； marker 绝不进入快照/payload（Phase 1916
 *    Step B）；探测遇未知 I/O → fail-closed typed；
 * 1. copyDir live source → 快照目录；
 * 2. 从快照计算 manifest（= 实际将发布的内容）；
 * 3. 复核：快照不得含 marker（复制窗口内 marker 出现被复制）、live source 此时
 *    不得带 marker（复制后进入新一轮发布）、live manifest 仍等于快照 manifest
 *    ——任一不满足 = 快照期间 source 被编辑/发布，删除半成品快照并重试；
 * 4. 超过有界重试仍不稳定/未提交 → typed fail-closed，调用方稍后重试。
 * expectedManifest 非 null 时（恢复重建路径）快照还必须等于 intent payload，
 * 否则显式冲突（调用方已前置判读，此处为不变量兜底）。
 * 残余边界：source「改了又改回完全相同字节」的 ABA 在普通 FS 上不可检测，
 * 属平台限制而非相邻检查掩盖——快照内容本身始终是自一致版本。
 */
async function materializeSourceSnapshot(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  srcAbs: string,
  snapshotAbs: string,
  expectedManifest: SkillSourceManifestEntry[] | null,
): Promise<SkillSourceManifestEntry[]> {
  const parentFs = deps.fsFactory(path.dirname(snapshotAbs));
  const snapBase = path.basename(snapshotAbs);
  const sourceFs = deps.fsFactory(srcAbs);
  await parentFs.ensureDir('.');
  // 追踪失败原因：mid-publish（source 未提交）与 unstable（内容变化）报错语义不同
  let lastFailure: 'mid_publish' | 'unstable' = 'unstable';
  for (let attempt = 1; attempt <= SOURCE_SNAPSHOT_MAX_ATTEMPTS; attempt++) {
    await parentFs.removeDir(snapBase).catch(() => {
      // silent: 清理上一趟半成品快照失败不掩盖后续重试；残留可人工删
    });
    // 0. source 发布态：未提交 → 等不到本趟一致快照，重试
    const preMarker = probeSourcePublishMarker(sourceFs);
    if (preMarker === 'unknown') {
      throw new CliError(
        `Skill source "${srcAbs}" publish state is unreadable (${SKILL_PUBLISH_MARKER} probe failed); ` +
        `fail-closed — inspect the source before retrying`,
      );
    }
    if (preMarker === 'present') {
      lastFailure = 'mid_publish';
      continue;
    }
    try {
      await copyDir(deps, srcAbs, snapshotAbs);
      await stripCommitProof(deps, snapshotAbs); // source 可能含 post-commit 证据，不进快照
    } catch {
      lastFailure = 'unstable';
      continue; // 复制中途 source 文件被改/删 → 视为快照期间变化，重试
    }
    const snapFs = deps.fsFactory(snapshotAbs);
    let snapManifest: SkillSourceManifestEntry[];
    try {
      snapManifest = computeSkillSourceManifest(snapFs);
    } catch {
      lastFailure = 'unstable';
      continue; // 快照目录被并发同名安装的孤儿 sweep 清掉 → 视为环境变化，重试
    }
    // 3a. 复制窗口内 marker 出现并被复制 → 本趟快照含协议工件，丢弃重试
    if (snapManifest.some((e) => e.path === SKILL_PUBLISH_MARKER)) {
      lastFailure = 'mid_publish';
      continue;
    }
    // 3b. 复制后 source 进入新一轮发布 → 快照取自未提交边界，丢弃重试
    const postMarker = probeSourcePublishMarker(sourceFs);
    if (postMarker === 'unknown') {
      throw new CliError(
        `Skill source "${srcAbs}" publish state is unreadable (${SKILL_PUBLISH_MARKER} probe failed); ` +
        `fail-closed — inspect the source before retrying`,
      );
    }
    if (postMarker === 'present') {
      lastFailure = 'mid_publish';
      continue;
    }
    let liveAfter: SkillSourceManifestEntry[];
    try {
      liveAfter = computeSkillSourceManifest(sourceFs);
    } catch {
      lastFailure = 'unstable';
      continue; // 复核时 source 不可读 → 视为快照期间变化，重试
    }
    if (JSON.stringify(snapManifest) !== JSON.stringify(liveAfter)) {
      lastFailure = 'unstable';
      continue;
    }
    if (expectedManifest !== null &&
        JSON.stringify(snapManifest) !== JSON.stringify(expectedManifest)) {
      throw new CliError(
        `Skill source "${srcAbs}" no longer matches the interrupted install payload; ` +
        `evidence preserved, inspect and remove the claim to retry`,
      );
    }
    return snapManifest;
  }
  await parentFs.removeDir(snapBase).catch(() => {
    // silent: 失败快照非证据（不含目标字节），清理失败可人工删
  });
  if (lastFailure === 'mid_publish') {
    throw new CliError(
      `Skill source "${srcAbs}" is still mid-publish (${SKILL_PUBLISH_MARKER} present after ` +
      `${SOURCE_SNAPSHOT_MAX_ATTEMPTS} attempts); retry after the source publish completes`,
    );
  }
  throw new CliError(
    `Skill source "${srcAbs}" kept changing while taking a consistent snapshot ` +
    `(${SOURCE_SNAPSHOT_MAX_ATTEMPTS} attempts); retry the install`,
  );
}

/**
 * 清扫同名 skill 的陈旧 source snapshot（claim 已串行化同名安装，未被当前
 * intent 引用或引用已随全目标 published 失效的快照属孤儿——如「快照完成、
 * claim 写入前崩溃」或「全发布后清理前崩溃」窗口的残留）。
 * Phase 1916 Step D：best-effort 但失败可观察（console.warn 留证），下一次
 * 同名安装的 sweep 可安全重试。
 */
function sweepStaleSourceSnapshots(
  claimFs: FileSystem,
  claimDirRel: string,
  skillName: string,
  keepName: string | undefined,
): void {
  const prefix = `${SKILL_SOURCE_SNAPSHOT_PREFIX}${skillName}-`;
  let entries: { name: string; isDirectory: boolean }[];
  try {
    // includeDirs：快照是目录，不带 includeDirs 的 listSync 不返回目录条目
    entries = claimFs.listSync(claimDirRel, { includeDirs: true });
  } catch (err) {
    console.warn(`Warning: failed to list skill source snapshots in ${claimDirRel}: ${err}`);
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory || !e.name.startsWith(prefix)) continue;
    if (keepName !== undefined && e.name === keepName) continue;
    try {
      claimFs.removeDirSync(`${claimDirRel}/${e.name}`);
    } catch (err) {
      console.warn(`Warning: failed to sweep stale skill source snapshot ${e.name}: ${err}`);
    }
  }
}

/**
 * 单目标发布（Phase 1911 G + 1912 Step D / RACE-SKILL-SWAP-EMPTY-TARGET）：
 * - absent 目标：mkdirExclusiveSync 占位 + 写发布态 marker（Phase 1913 C：
 *   marker 在 = 未提交不可消费）+ 逐文件 linkExclusiveSync no-replace
 *   落位——rename 不再接触目标路径，并发出现的占位（含空目录）必冲突；
 *   落位后扫描目标恰含 manifest 文件 + marker（外部混入 → 冲突留证）；
 *   sweep 通过后删 marker = 提交（单向事实）；
 * - existing 目标（更新语义，显式 replace）：旧版 rename 入唯一 trash →
 *   探测目标必须缺席（窗口内被外部重建 → 还原旧版 + 冲突留证）→
 *   rename staging 落位 → 以 SKILL.md 内容 hash 核验落位的是我们的 staging。
 *   残余边界：探测与 rename 相邻 syscall 间外部重建的空占位仍会被替换——
 *   仅限空目录、无字节损失；Chestnut 安装调用方已由 per-skill claim 串行化。
 * 任何中途失败保留 staging/trash 证据；发布窗口内目标只可能短暂缺失，
 * 绝不半版混合（existing 分支）。
 */
async function publishSkillDirSwap(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  srcAbs: string,
  destAbs: string,
  manifest: SkillSourceManifestEntry[],
  identity: {
    /** marker 证据记录的原始 source（srcAbs 可能是本方快照目录）。 */
    originSourceAbs?: string;
    /** Phase 1916 Step C：写入 marker 的 install 占有证据。 */
    installId: string;
    /**
     * 提交点前回调（持久化 committing 状态）：absent 分支在 sweep 后、删 marker
     * 前调用；existing 分支在 staging 就绪后、旧版让位前调用。
     */
    beforeCommit?: (branch: 'absent' | 'existing') => void;
  },
): Promise<void> {
  const parent = path.dirname(destAbs);
  const base = path.basename(destAbs);
  const parentFs = deps.fsFactory(parent);
  await parentFs.ensureDir('.');
  const stageName = `.skill-staging-${newShortUuid()}`;
  const trashName = `.skill-trash-${newShortUuid()}`;
  await copyDir(deps, srcAbs, path.join(parent, stageName));
  await stripCommitProof(deps, path.join(parent, stageName)); // 证据不随 staging 落位

  if (!(await parentFs.stat(base).catch(() => null))) {
    // ---- absent 目标：占位 + no-replace 逐文件落位 ----
    // Phase 1913 Step C（RACE-PUBLISH-PRECOMMIT-VISIBILITY）：占位后立即写
    // 发布态 marker（foundation skill-system owner 约定），落位+sweep 通过后
    // 才删除（删除=提交）——marker 在 = SkillSystem 不可消费，消费者不再凭
    // SKILL.md 存在猜测版本完整。
    try {
      parentFs.mkdirExclusiveSync(base);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        await parentFs.removeDir(stageName).catch(() => {
          // silent: 我方 staging 清理失败不掩盖冲突事实；残留可人工删
        });
        throw new CliError(
          `Skill target "${destAbs}" appeared concurrently; conflict — not overwritten`,
        );
      }
      throw err;
    }
    const markerRel = `${base}/${SKILL_PUBLISH_MARKER}`;
    parentFs.writeAtomicSync(markerRel, JSON.stringify({
      source: identity.originSourceAbs ?? srcAbs,
      manifestHash: sha256Hex(JSON.stringify(manifest)),
      installId: identity.installId,
      startedAt: new Date().toISOString(),
    }, null, 2));
    for (const entry of manifest) {
      const destRel = `${base}/${entry.path}`;
      try {
        parentFs.linkExclusiveSync(`${stageName}/${entry.path}`, destRel);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
        // 已落位：同 hash 收敛（恢复续传）；异内容冲突留证
        const destContent = await parentFs.read(destRel).catch(() => null);
        if (destContent === null || sha256Hex(destContent) !== entry.sha256) {
          throw new CliError(
            `Skill target "${destAbs}" file "${entry.path}" exists with different bytes; ` +
            `conflict — evidence preserved, not overwritten`,
          );
        }
      }
    }
    // 外部混入扫描：目标必须恰含 manifest 文件 + 发布态 marker
    const expected = new Set([...manifest.map((e) => `${base}/${e.path}`), markerRel]);
    const extra = parentFs
      .listSync(base, { recursive: true })
      .filter((e) => e.isFile)
      .map((e) => e.path)
      .filter((p) => !expected.has(p));
    if (extra.length > 0) {
      throw new CliError(
        `Skill target "${destAbs}" was modified during install (unexpected: ${extra.join(', ')}); ` +
        `conflict — evidence preserved`,
      );
    }
    // 提交点（Phase 1916 Step C + follow-up）：
    // 1. 先写 post-commit 身份证据（SKILL_COMMIT_PROOF，target-local 协议工件，
    //    证明「其后的 marker 删除是本 intent 的提交动作」——必须先于提交点
    //    持久化，否则 committing+marker 缺席窗口无磁盘事实可重建）；
    // 2. 再持久化 committing（恢复可区分提交窗口）；
    // 3. 最后删 marker（marker 缺席 = 已提交完整版本，单向事实）→ 清 staging
    const proofRel = `${base}/${SKILL_COMMIT_PROOF}`;
    parentFs.writeAtomicSync(proofRel, JSON.stringify({
      installId: identity.installId,
      manifestHash: sha256Hex(JSON.stringify(manifest)),
      branch: 'absent',
      committedAt: new Date().toISOString(),
    }, null, 2));
    identity.beforeCommit?.('absent');
    parentFs.deleteSync(markerRel);
    await parentFs.removeDir(stageName).catch(() => {
      // silent: staging 清理失败不影响已发布事实；残留 `.skill-staging-*` 可人工删
    });
    return;
  }

  // ---- existing 目标：旧版让位 + 身份核验的显式 replace ----
  // 提交点（Phase 1916 Step C）：staging 就绪后先持久化 committing（恢复可
  // 区分「swap 前崩溃：旧版未被触碰」与「swap 后崩溃：新版已生效」），再让位。
  identity.beforeCommit?.('existing');
  await parentFs.moveDir(base, trashName); // 旧版整体让位（rename 原子）
  if (await parentFs.stat(base).catch(() => null)) {
    // 让位窗口内目标被外部重建 → 还原旧版，冲突留证
    await parentFs.moveDir(trashName, base).catch(() => {
      // silent: 还原失败（外部目录非空）—— trash 保留旧版证据，错误原样上抛
    });
    throw new CliError(
      `Skill target "${destAbs}" was recreated externally during update; ` +
      `conflict — previous version restored where possible, evidence preserved`,
    );
  }
  try {
    await parentFs.moveDir(stageName, base);
  } catch (err) {
    await parentFs.moveDir(trashName, base).catch(() => {
      // silent: 还原失败 —— trash 目录保留旧版证据，错误原样上抛
    });
    throw err;
  }
  // 落位核验：目标内 SKILL.md（或 manifest 首文件）hash 必须等于源快照——
  // 证明落位的是我们的 staging 而非窗口内被换入的外部目录
  const probe = manifest.find((e) => e.path === 'SKILL.md') ?? manifest[0];
  const probeContent = await parentFs.read(`${base}/${probe.path}`).catch(() => null);
  if (probeContent === null || sha256Hex(probeContent) !== probe.sha256) {
    throw new CliError(
      `Skill target "${destAbs}" post-publish identity check failed; ` +
      `conflict — evidence preserved (old version trash: ${path.join(parent, trashName)})`,
    );
  }
  await parentFs.removeDir(trashName).catch(() => {
    // silent: trash 清理失败不影响已发布事实；残留 `.skill-trash-*` 可人工删
  });
}

/* ---------- Phase 1916 Step C: recovery target identity ---------- */

/** 目标目录内容 hash（与 source manifest 同构造），作 recovery 身份证据。 */
function targetContentHash(targetFs: FileSystem): string {
  return sha256Hex(JSON.stringify(computeSkillSourceManifest(targetFs)));
}

/** 类型化读取目标 marker；缺席 → null，不可解析/未知 I/O → 原样用于判读。 */
function readSkillPublishMarker(
  parentFs: FileSystem,
  markerRel: string,
): { installId?: string; manifestHash?: string } | null {
  let raw: string;
  try {
    raw = parentFs.readSync(markerRel);
  } catch (err) {
    if (isFileNotFound(err)) return null;
    if ((err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return null;
    throw err; // 未知 I/O：fail-closed 上抛，不当缺席
  }
  try {
    return JSON.parse(raw) as { installId?: string; manifestHash?: string };
  } catch (err) {
    throw new CliError(
      `Skill publish marker ${markerRel} is unreadable; conflict — evidence preserved (${formatErr(err)})`,
    );
  }
}

type RecoveryAction = 'publish' | 'commit-finish' | 'skip-published';

/** post-commit 身份证据内容（SKILL_COMMIT_PROOF，foundation skill-system owner）。 */
interface SkillCommitProof {
  installId?: string;
  manifestHash?: string;
  branch?: string;
  committedAt?: string;
}

/**
 * 类型化读取 post-commit 证据；缺席 → null，不可解析 → typed 冲突，未知 I/O
 * 原样上抛（fail-closed，不当缺席——证据缺席与不可读必须可区分）。
 */
function readSkillCommitProof(parentFs: FileSystem, proofRel: string): SkillCommitProof | null {
  let raw: string;
  try {
    raw = parentFs.readSync(proofRel);
  } catch (err) {
    if (isFileNotFound(err)) return null;
    if ((err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as SkillCommitProof;
  } catch (err) {
    throw new CliError(
      `Skill commit proof ${proofRel} is unreadable; conflict — evidence preserved (${formatErr(err)})`,
    );
  }
}

/** 证据与 intent 的占有关联：installId + manifestHash 必须同时相符。 */
function commitProofMatches(
  proof: SkillCommitProof | null,
  intent: SkillInstallIntent,
  manifestHash: string,
): boolean {
  return proof !== null && proof.installId === intent.id && proof.manifestHash === manifestHash;
}

/**
 * 恢复路径 target 身份判读（Phase 1916 Step C，
 * RACE-SKILL-RECOVERY-TARGET-IDENTITY）：只续传/补登记能证明属于本 intent 的
 * target；证据缺失或外部字节出现 → typed 冲突留证，绝不覆盖或误接受崩溃后
 * 外部出现的目录。
 *
 * 判读事实（全部可从磁盘重建）：intent 逐目标 state / preState（崩溃前先态）
 * / commitBranch，目标内容 hash，marker 的 installId + manifestHash，
 * post-commit 证据（SKILL_COMMIT_PROOF）的 installId + manifestHash。
 * - pending：本 intent 未触碰该目标——目标缺席可发布；目标在场须等于
 *   preState（合法 update 目标未被触碰），preState=absent 或内容偏离 → 冲突；
 * - publishing：marker 在场须携带本 intent 的 installId + manifestHash（本方
 *   半成品）；marker 缺席时 v2 协议下提交前必经 committing——内容恰等于
 *   manifest 幂等收敛、等于 preState 则旧版未被触碰可重做 update，其余冲突；
 * - committing：commitBranch=absent 且 marker 在场 → 完成提交；marker 缺席时
 *   须目标仍在且 post-commit 证据属于本 intent 才补登记（证据不核验 payload
 *   hash，其后用户编辑合法保留）；目标删除/证据缺席/身份不符 → 冲突留证；
 *   commitBranch=existing 按 swap 是否生效（内容 hash）判读。
 */
async function classifyRecoveryTarget(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  intent: SkillInstallIntent,
  target: SkillInstallIntent['targets'][number],
  abs: string,
): Promise<RecoveryAction> {
  const parentFs = deps.fsFactory(path.dirname(abs));
  const base = path.basename(abs);
  const markerRel = `${base}/${SKILL_PUBLISH_MARKER}`;
  const manifestHash = sha256Hex(JSON.stringify(intent.manifest));
  const conflict = (detail: string): CliError => new CliError(
    `Skill target "${abs}" identity cannot be proven for the interrupted install ` +
    `(${detail}); conflict — target/claim/snapshot evidence preserved, not overwritten`,
  );

  const targetPresent = await parentFs.stat(base).catch((err: unknown) => {
    if (isFileNotFound(err) || (err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return null;
    throw err;
  });

  // legacy schema-1 intent（1915 及更早：无 installId/preState/committing 事实）：
  // 沿用 1915 判读——publishing + marker 缺席补登记，其余续传/发布。
  if (intent.schema_version !== 2 || target.preState === undefined) {
    if (target.state !== 'publishing') return 'publish';
    if (targetPresent === null) return 'publish';
    const marker = readSkillPublishMarker(parentFs, markerRel);
    return marker === null ? 'skip-published' : 'publish';
  }

  const preHash = target.preState === 'absent' ? null : target.preState.contentHash;
  const currentHash = targetPresent !== null ? targetContentHash(deps.fsFactory(abs)) : null;
  const marker = targetPresent !== null ? readSkillPublishMarker(parentFs, markerRel) : null;
  const markerOurs = marker !== null && marker.installId === intent.id && marker.manifestHash === manifestHash;

  if (target.state === 'pending') {
    if (targetPresent === null) return 'publish'; // 目标缺席：无外部字节可伤
    if (preHash === null) {
      throw conflict('target appeared externally after the crash (preState=absent)');
    }
    if (currentHash === preHash) return 'publish'; // 合法 update 目标未被触碰
    throw conflict('target bytes changed externally after the crash');
  }

  if (target.state === 'publishing') {
    if (targetPresent === null) return 'publish'; // existing swap 窗口/占位前崩溃
    if (marker !== null) {
      if (markerOurs) return 'publish'; // 本方半成品（marker 占有证据相符）
      throw conflict('publish marker does not belong to this install intent');
    }
    // marker 缺席 + publishing：v2 协议下提交前必经 committing，故此组合绝非
    // 本 intent 已提交——内容与 manifest 一致仅作幂等收敛，其余必冲突。
    if (currentHash === manifestHash) return 'skip-published';
    if (preHash !== null && currentHash === preHash) return 'publish'; // 旧版未被触碰，重做 update
    throw conflict('target was replaced externally with a marker-free directory');
  }

  // committing：提交点进行中崩溃
  if (marker !== null) {
    if (target.commitBranch === 'absent' && markerOurs) return 'commit-finish';
    throw conflict('committing state with an unexpected publish marker');
  }
  if (target.commitBranch === 'absent') {
    // Phase 1916 Step C follow-up（RACE-SKILL-COMMITTING-ABSENT-IDENTITY）：
    // marker 缺席只是单向事实，不能单独证明「删除是本 intent 的提交动作」——
    // 必须目标仍在且具备本 intent 的 post-commit 证据才补登记；目标删除、
    // 外部替换（证据缺席）或证据身份不符 → typed 冲突留证，不误接受。
    if (targetPresent === null) {
      throw conflict('target was deleted after the commit point (post-commit proof lost with it)');
    }
    const proof = readSkillCommitProof(parentFs, `${base}/${SKILL_COMMIT_PROOF}`);
    if (!commitProofMatches(proof, intent, manifestHash)) {
      throw conflict('post-commit proof is missing or does not belong to this install intent');
    }
    // 证据只证明本 intent 已完成发布，不核验 payload hash——其后的用户编辑
    // 合法保留（skip-published 不重写任何字节）
    return 'skip-published';
  }
  if (target.commitBranch === 'existing') {
    if (targetPresent === null) return 'publish'; // swap 窗口内崩溃（trash 留证）
    if (currentHash === manifestHash) return 'skip-published'; // swap 已生效
    if (preHash !== null && currentHash === preHash) return 'publish'; // committing 登记后、swap 前崩溃
    throw conflict('committing state with unrecognized target bytes');
  }
  throw conflict('committing state without a recorded commit branch');
}

/**
 * 完成 absent 分支提交（committing + 本方 marker 在场）：复核落位证据后删
 * marker。证据已破坏（文件缺失/异内容/外部混入）→ typed 冲突留证。
 */
function finishAbsentBranchCommit(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  intent: SkillInstallIntent,
  abs: string,
): void {
  const parentFs = deps.fsFactory(path.dirname(abs));
  const base = path.basename(abs);
  const markerRel = `${base}/${SKILL_PUBLISH_MARKER}`;
  const proofRel = `${base}/${SKILL_COMMIT_PROOF}`;
  const expected = new Set([...intent.manifest.map((e) => `${base}/${e.path}`), markerRel, proofRel]);
  const actual = parentFs.listSync(base, { recursive: true }).filter((e) => e.isFile).map((e) => e.path);
  const extra = actual.filter((p) => !expected.has(p));
  const missing = intent.manifest.filter((e) => !actual.includes(`${base}/${e.path}`));
  const mismatched = intent.manifest.filter((e) => {
    if (!actual.includes(`${base}/${e.path}`)) return false; // missing 单独报告
    const content = parentFs.readSync(`${base}/${e.path}`);
    return sha256Hex(content) !== e.sha256;
  });
  if (extra.length > 0 || missing.length > 0 || mismatched.length > 0) {
    throw new CliError(
      `Skill target "${abs}" landing evidence is broken at commit finish ` +
      `(extra: ${extra.join(', ') || '-'}; missing: ${missing.map((e) => e.path).join(', ') || '-'}; ` +
      `mismatched: ${mismatched.map((e) => e.path).join(', ') || '-'}); conflict — evidence preserved`,
    );
  }
  // 落位证据完整后还必须核验 post-commit 身份证据（committing 登记前已写入）——
  // 缺席/身份不符 = 提交窗口被外部干预，拒绝删 marker（拒绝即未提交，留证）
  const proof = readSkillCommitProof(parentFs, proofRel);
  if (!commitProofMatches(proof, intent, sha256Hex(JSON.stringify(intent.manifest)))) {
    throw new CliError(
      `Skill target "${abs}" post-commit proof is missing or does not belong to this install intent ` +
      `at commit finish; conflict — evidence preserved`,
    );
  }
  parentFs.deleteSync(markerRel); // 提交：marker 缺席 = 已提交完整版本
}

/**
 * 清理 target 根的 post-commit 身份证据（Phase 1916 Step C follow-up）：证据
 * 只服务 committing 窗口的恢复判读，intent 登记 published 后使命结束。
 * best-effort：缺席是常态（existing 分支不写证据/上次已清理）；清理失败
 * console.warn 留证，残留证据不进 payload/manifest，由下次恢复或更新收敛。
 */
function cleanupCommitProof(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  abs: string,
): void {
  const parentFs = deps.fsFactory(path.dirname(abs));
  const proofRel = `${path.basename(abs)}/${SKILL_COMMIT_PROOF}`;
  try {
    parentFs.deleteSync(proofRel);
  } catch (err) {
    if (isFileNotFound(err) || (err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return;
    console.warn(`Warning: failed to clean up skill commit proof ${proofRel}: ${err}`);
  }
}

/**
 * per-skill claim + durable intent 驱动的逐目标独立提交。
 * 返回各目标安装前的 exists 快照（供 Installed/Updated 输出）。
 *
 * Phase 1915 Step C：source 先 materialize 成不可变快照（快照即 source
 * identity，随 intent 持久化），发布与恢复都只从快照读取——Motion 在复制
 * 期间编辑 dispatch pool 时，Claw 要么得到编辑前/后的完整一致版本，要么
 * 得到明确冲突/重试信号，绝不得到混合文件。
 */
async function runSkillInstall(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  opts: {
    skillName: string;
    srcAbs: string;
    claimFs: FileSystem;
    claimRel: string;
    targets: { id: string; absPath: string }[];
  },
): Promise<{ resumed: boolean }> {
  const claimDirRel = path.posix.dirname(opts.claimRel);
  const claimParentAbs = path.dirname(opts.claimFs.resolve(opts.claimRel));

  let intent: SkillInstallIntent | undefined;
  let resumed = false;
  let snapshotAbs: string | null = null;

  // claim 是否已在场（恢复/冲突判读路径）——typed 探测：缺席之外的未知 I/O
  // 错误原样上抛，不当「可写入」处理
  let claimExisted = true;
  try {
    opts.claimFs.statSync(opts.claimRel);
  } catch (err) {
    if (isFileNotFound(err) || (err as NodeJS.ErrnoException)?.code === 'ENOTDIR') {
      claimExisted = false;
    } else {
      throw err;
    }
  }

  if (!claimExisted) {
    // ---- fresh：先拍自一致快照（快照 manifest = 权威 payload），再独占写 claim ----
    const token = newShortUuid();
    const snapName = `${SKILL_SOURCE_SNAPSHOT_PREFIX}${opts.skillName}-${token}`;
    const snapAbs = path.join(claimParentAbs, snapName);
    const manifest = await materializeSourceSnapshot(deps, opts.srcAbs, snapAbs, null);
    // Phase 1916 Step C：登记逐目标先态（recovery 身份证据）——类型化探测，
    // 未知 I/O 原样上抛；目标在场则记录其内容 hash（合法 update 目标判读基准）
    const targetsWithPreState: SkillInstallIntent['targets'] = [];
    for (const t of opts.targets) {
      const present = await deps.fsFactory(path.dirname(t.absPath)).stat(path.basename(t.absPath))
        .catch((err: unknown) => {
          if (isFileNotFound(err) || (err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return null;
          throw err;
        });
      targetsWithPreState.push({
        id: t.id,
        state: 'pending',
        preState: present === null
          ? 'absent'
          : { contentHash: targetContentHash(deps.fsFactory(t.absPath)) },
      });
    }
    const fresh: SkillInstallIntent = {
      schema_version: 2,
      token,
      id: newShortUuid(),
      skillName: opts.skillName,
      source: opts.srcAbs,
      pid: process.pid,
      process_start_time: getProcessStartTime(process.pid),
      startedAt: new Date().toISOString(),
      manifest,
      sourceSnapshot: snapName,
      targets: targetsWithPreState,
    };
    try {
      opts.claimFs.writeExclusiveSync(opts.claimRel, JSON.stringify(fresh, null, 2));
      intent = fresh;
      snapshotAbs = snapAbs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      // 快照与 claim 写入之间出现并发 holder → 本方快照让位，转入恢复判读
      await deps.fsFactory(claimParentAbs).removeDir(snapName).catch(() => {
        // silent: 本方快照清理失败不掩盖冲突判读；残留由 winner 清扫
      });
    }
  }

  if (intent === undefined) {
    // claim 已存在：读 durable intent 判读 —— 活 holder 冲突；死 holder +
    // 同 source 恢复（快照身份核验在下方）；异 source 显式冲突留证。
    intent = readExistingInstallIntent(opts.claimFs, opts.claimRel, opts.skillName);
    resumed = true;
    if (intent.source !== opts.srcAbs) {
      throw new CliError(
        `Skill "${opts.skillName}" has an interrupted install with a different source payload ` +
        `(claim: ${opts.claimRel}, source: ${intent.source}); evidence preserved, remove it manually to retry`,
      );
    }
    const needsPublish = intent.targets.some((t) => t.state !== 'published');
    if (needsPublish) {
      // 优先复用持久快照（= 中断时的 source identity）：即使 live source 已被
      // 合法编辑，恢复仍完成「编辑前的完整版本」，不混入新字节。
      if (typeof intent.sourceSnapshot === 'string' && intent.sourceSnapshot !== '') {
        const candidate = path.join(claimParentAbs, intent.sourceSnapshot);
        if (await deps.fsFactory(candidate).stat('.').catch(() => null) !== null) {
          const snapManifest = computeSkillSourceManifest(deps.fsFactory(candidate));
          if (JSON.stringify(snapManifest) !== JSON.stringify(intent.manifest)) {
            throw new CliError(
              `Skill "${opts.skillName}" source snapshot "${intent.sourceSnapshot}" does not match ` +
              `its install intent (claim: ${opts.claimRel}); conflict — evidence preserved`,
            );
          }
          snapshotAbs = candidate;
        }
      }
      if (snapshotAbs === null) {
        // 快照缺失 → live source 必须仍等于 intent payload 才能重建；
        // source generation 已变化 → 显式冲突，不把新字节归入旧 intent
        const liveManifest = computeSkillSourceManifest(deps.fsFactory(opts.srcAbs));
        if (JSON.stringify(liveManifest) !== JSON.stringify(intent.manifest)) {
          throw new CliError(
            `Skill "${opts.skillName}" has an interrupted install with a different source payload ` +
            `(claim: ${opts.claimRel}, source: ${intent.source}); evidence preserved, remove it manually to retry`,
          );
        }
        const snapName = `${SKILL_SOURCE_SNAPSHOT_PREFIX}${opts.skillName}-${intent.token}`;
        snapshotAbs = path.join(claimParentAbs, snapName);
        await materializeSourceSnapshot(deps, opts.srcAbs, snapshotAbs, intent.manifest);
        intent.sourceSnapshot = snapName;
        opts.claimFs.writeAtomicSync(opts.claimRel, JSON.stringify(intent, null, 2));
      }
    }
  }

  // 清扫同名陈旧快照（Phase 1916 Step D，HYGIENE-SKILL-SOURCE-SNAPSHOT-ORPHAN）：
  // claim 串行化同名安装，唯一 live intent 就是本方——仅当快照仍将用于发布
  // （snapshotAbs 已核验绑定）才保留引用；all-published 恢复（上次崩溃于
  // 快照清理/claim 释放前）不再引用快照，一并清扫收敛，不留无引用孤儿。
  sweepStaleSourceSnapshots(
    opts.claimFs,
    claimDirRel,
    opts.skillName,
    snapshotAbs !== null ? intent.sourceSnapshot : undefined,
  );

  if (snapshotAbs !== null) {
    const persistIntent = (): void => {
      opts.claimFs.writeAtomicSync(opts.claimRel, JSON.stringify(intent, null, 2));
    };
    for (const target of intent.targets) {
      if (target.state === 'published') {
        // 崩溃于「published 登记后、证据清理前」的残留 post-commit 证据收敛
        const doneAbs = opts.targets.find((t) => t.id === target.id)?.absPath;
        if (doneAbs !== undefined) cleanupCommitProof(deps, doneAbs);
        continue;
      }
      const abs = opts.targets.find((t) => t.id === target.id)?.absPath;
      if (!abs) {
        throw new CliError(
          `Install intent for skill "${opts.skillName}" references unknown target "${target.id}" ` +
          `(claim: ${opts.claimRel}); evidence preserved, not overwriting`,
        );
      }
      // Phase 1915 Step B + 1916 Step C：恢复路径按 target-local 提交事实与
      // 占有证据判读——只续传/补登记能证明属于本 intent 的 target；证据缺失或
      // 外部字节 → typed 冲突留证，绝不覆盖或误接受崩溃后外部出现的目录。
      if (resumed) {
        const action = await classifyRecoveryTarget(deps, intent, target, abs);
        if (action === 'skip-published') {
          target.state = 'published';
          delete target.commitBranch;
          persistIntent();
          cleanupCommitProof(deps, abs);
          continue;
        }
        if (action === 'commit-finish') {
          finishAbsentBranchCommit(deps, intent, abs);
          target.state = 'published';
          delete target.commitBranch;
          persistIntent();
          cleanupCommitProof(deps, abs);
          continue;
        }
      }
      target.state = 'publishing';
      persistIntent();
      await publishSkillDirSwap(deps, snapshotAbs, abs, intent.manifest, {
        originSourceAbs: intent.source,
        installId: intent.id,
        beforeCommit: (branch) => {
          target.commitBranch = branch;
          target.state = 'committing';
          persistIntent();
        },
      });
      target.state = 'published';
      delete target.commitBranch;
      persistIntent();
      // published 已持久化 → post-commit 证据使命结束（崩溃残留由下次恢复收敛）
      cleanupCommitProof(deps, abs);
    }

    // 全部目标发布完成 → 快照使命结束（失败/冲突路径保留快照供恢复）
    await deps.fsFactory(claimParentAbs).removeDir(path.basename(snapshotAbs)).catch((err) => {
      // Phase 1916 Step D：清理失败保留可观察证据（不静默丢失责任）——
      // 残留 `.skill-srcsnap-*` 由下一次同名安装的 sweep 收敛
      console.warn(`Warning: failed to clean up skill source snapshot ${snapshotAbs}: ${err}`);
    });
  }

  try {
    opts.claimFs.deleteSync(opts.claimRel);
  } catch (err) {
    // best-effort：claim 释放失败不影响已发布事实；残留 intent 全 published，
    // 下次同名安装按恢复路径快速收敛
    console.warn(`Warning: failed to release skill install claim ${opts.claimRel}: ${err}`);
  }
  return { resumed };
}

/**
 * 判读既有 claim：活 holder → in-progress 冲突；死 holder → 接管 holder 身份
 * 后交调用方做 payload 判读（Phase 1915 Step C：持久快照在场时恢复不再依赖
 * live source 未变）；claim 不可读/不可解析 → 显式留证。
 */
function readExistingInstallIntent(
  claimFs: FileSystem,
  claimRel: string,
  skillName: string,
): SkillInstallIntent {
  let raw: string;
  try {
    raw = claimFs.readSync(claimRel);
  } catch (err) {
    throw new CliError(
      `Skill "${skillName}" install claim exists but is unreadable: ${claimRel}; ` +
      `inspect manually (${formatErr(err)})`,
    );
  }
  let intent: SkillInstallIntent;
  try {
    intent = JSON.parse(raw) as SkillInstallIntent;
  } catch {
    throw new CliError(
      `Skill "${skillName}" install claim is malformed: ${claimRel}; evidence preserved, remove it manually to retry`,
    );
  }
  const holderAlive = typeof intent.pid === 'number'
    ? isAlive(intent.pid, typeof intent.process_start_time === 'string' && intent.process_start_time !== ''
      ? makeProcessStartTime(intent.process_start_time)
      : undefined)
    : true; // 无 pid 可探测 → 保守按存活冲突
  if (holderAlive) {
    throw new CliError(
      `Skill "${skillName}" install already in progress (pid=${intent.pid}); ` +
      `if it was interrupted, remove ${claimRel} and retry`,
    );
  }
  // holder 已证明死亡
  if (intent.skillName !== skillName) {
    throw new CliError(
      `Skill "${skillName}" has an interrupted install with a different source payload ` +
      `(claim: ${claimRel}, source: ${intent.source}); evidence preserved, remove it manually to retry`,
    );
  }
  // 接管 holder 身份；payload 判读（source 路径 + 快照身份/generation）归调用方
  intent.pid = process.pid;
  intent.process_start_time = getProcessStartTime(process.pid);
  intent.token = newShortUuid();
  claimFs.writeAtomicSync(claimRel, JSON.stringify(intent, null, 2));
  return intent;
}

/**
 * User mode: install skill from local path to workspace
 * - Copy to root/skills/{skillName}/
 * - Sync to motion/clawspace/dispatch-skills/{skillName}/
 */
export async function skillInstallUserCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, sourcePath: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  const root = getWorkspaceRoot();
  const absSource = path.resolve(sourcePath);

  // Skill name = source directory name
  const skillName = path.basename(absSource);
  // phase 446 (review N3-H skill): user-mode 补 claw-mode L65-76 同款 sanity guard。
  // 防 path.basename(absSource) 派生出 ''/'.'/含 .. 等病态名后 path.join(root,
  // SKILLS_DIR, skillName) 解析到非预期位置（如 root 自身）、copyDir 写到非 skills/ 下。
  if (
    typeof skillName !== 'string' || skillName === '' || skillName === '.' || skillName.startsWith('.') ||
    skillName.includes('/') || skillName.includes('..')
  ) {
    throw new CliError(`Invalid skill name derived from source path: ${JSON.stringify(skillName)} (source=${absSource})`);
  }

  // Verify SKILL.md exists
  const sourceFs = deps.fsFactory(absSource);
  if (!sourceFs.existsSync('SKILL.md')) {
    throw new CliError(`No SKILL.md found in ${absSource}`);
  }

  const motionDir = path.join(root, '.chestnut', 'motion');
  const destUser = path.join(root, SKILLS_DIR_DEFAULT, skillName);
  const destDispatch = path.join(motionDir, CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName);

  const rootFs = deps.fsFactory(root);
  const motionFs = deps.fsFactory(motionDir);
  const userExists = rootFs.existsSync(path.join(SKILLS_DIR_DEFAULT, skillName));
  const dispatchExists = motionFs.existsSync(path.join(CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName));

  const { resumed } = await runSkillInstall(deps, {
    skillName,
    srcAbs: absSource,
    claimFs: rootFs,
    claimRel: path.join(SKILLS_DIR_DEFAULT, `.${skillName}.installing`),
    targets: [
      { id: 'user', absPath: destUser },
      { id: 'dispatch', absPath: destDispatch },
    ],
  });

  // 成功 audit/输出只在两个目标都 published 后发出
  audit?.write(CLI_AUDIT_EVENTS.SKILL_INSTALL, `mode=user`, `skill=${skillName}`);
  console.log(`${userExists ? 'Updated' : 'Installed'} skills/${skillName}`);
  console.log(`${dispatchExists ? 'Updated' : 'Synced'} dispatch-skills/${skillName}`);
  if (resumed) {
    console.log(`  (resumed an interrupted install; remaining targets published)`);
  }
}

/**
 * Internal mode: install dispatch-skill to a specific claw
 * - Copy from motion/clawspace/dispatch-skills/{skillName}/
 * - To clawDir/skills/{skillName}/
 */
export async function skillInstallClawCommand(deps: { fsFactory: (baseDir: string) => FileSystem }, clawId: string, skillName: string, extraDeps?: { audit?: AuditLog }): Promise<void> {
  const audit = extraDeps?.audit;
  // Phase 537 — traversal guard for both identifier params
  if (
    typeof clawId !== 'string' || clawId === '' || clawId === '.' || clawId.startsWith('.') ||
    clawId.includes('/') || clawId.includes('..')
  ) {
    throw new CliError(`Invalid claw id: ${JSON.stringify(clawId)}`);
  }
  if (
    typeof skillName !== 'string' || skillName === '' || skillName === '.' || skillName.startsWith('.') ||
    skillName.includes('/') || skillName.includes('..')
  ) {
    throw new CliError(`Invalid skill name: ${JSON.stringify(skillName)}`);
  }

  const root = getWorkspaceRoot();
  const motionDir = path.join(root, '.chestnut', 'motion');
  const source = path.join(motionDir, CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName);
  const clawDir = getClawDir(clawId);
  const dest = path.join(clawDir, SKILLS_DIR_DEFAULT, skillName);

  const motionFs = deps.fsFactory(motionDir);
  if (!motionFs.existsSync(path.join(CLAWSPACE_DIR, DISPATCH_SKILLS_SUBDIR, skillName))) {
    throw new CliError(`dispatch-skill "${skillName}" not found`);
  }
  const clawFs = deps.fsFactory(clawDir);
  if (!clawFs.existsSync('.')) {
    throw new CliError(`claw "${clawId}" does not exist`);
  }

  await runSkillInstall(deps, {
    skillName,
    srcAbs: source,
    claimFs: clawFs,
    claimRel: path.join(SKILLS_DIR_DEFAULT, `.${skillName}.installing`),
    targets: [{ id: 'claw', absPath: dest }],
  });

  audit?.write(CLI_AUDIT_EVENTS.SKILL_INSTALL, `mode=claw`, `claw=${clawId}`, `skill=${skillName}`);
  console.log(`Installed ${skillName} to claw ${clawId}`);
}
