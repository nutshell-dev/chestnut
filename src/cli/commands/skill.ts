/**
 * Skill install commands
 *
 * User mode: install skill from local path to workspace
 * Internal mode: install dispatch-skill to a specific claw
 *
 * Phase 1911 Step G（RACE-CLI-SKILL-MULTIROOT-COPY）：多根一致提交协议。
 * 同一 skillName 的安装由 per-skill claim（O_EXCL durable intent）串行化：
 * - 每个目标根先复制到同父目录隐藏 staging，再以 rename 交换发布
 *   （旧版整体让位 → 新版整体落位；消费者只见完整旧版/完整新版/短暂缺失，
 *   永不见半版混合）；
 * - intent 持久记录 source manifest、target set 与逐目标 state；崩溃后凭
 *   intent 判定一致/未完成/冲突，holder 已死且 source payload 相同才自动
 *   恢复，payload 不同一律显式冲突留证；
 * - 成功 audit/输出只在目标集合全部 published 后发出。
 */

import { DISPATCH_SKILLS_SUBDIR } from '../../core/evolution-system/index.js';
import { getWorkspaceRoot } from '../../foundation/claw-identity/index.js';
import * as path from 'path';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { SKILLS_DIR_DEFAULT, SKILL_PUBLISH_MARKER } from '../../foundation/skill-system/index.js';
import { getClawDir } from '../../foundation/claw-identity/index.js';
import { newShortUuid, sha256Hex, formatErr } from '../../foundation/node-utils/index.js';
import { isAlive, getProcessStartTime, makeProcessStartTime } from '../../foundation/process-exec/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from '../audit-events.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { copyDir } from '../utils/copy-dir.js';

/* ---------- Phase 1911 Step G: durable install intent ---------- */

interface SkillSourceManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

interface SkillInstallIntent {
  schema_version: 1;
  token: string;
  skillName: string;
  source: string;
  pid: number;
  process_start_time?: string;
  startedAt: string;
  manifest: SkillSourceManifestEntry[];
  targets: { id: string; state: 'pending' | 'published' }[];
}

/** 源快照 manifest（路径+大小+内容 hash，排序确定）。源在复制期间被改属外部源快照边界。 */
function computeSkillSourceManifest(sourceFs: FileSystem): SkillSourceManifestEntry[] {
  return sourceFs
    .listSync('.', { recursive: true })
    .filter((e) => e.isFile)
    .map((e) => ({ path: e.path, size: e.size, sha256: sha256Hex(sourceFs.readSync(e.path)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
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
): Promise<void> {
  const parent = path.dirname(destAbs);
  const base = path.basename(destAbs);
  const parentFs = deps.fsFactory(parent);
  await parentFs.ensureDir('.');
  const stageName = `.skill-staging-${newShortUuid()}`;
  const trashName = `.skill-trash-${newShortUuid()}`;
  await copyDir(deps, srcAbs, path.join(parent, stageName));

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
      source: srcAbs,
      manifestHash: sha256Hex(JSON.stringify(manifest)),
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
    // 提交：删 marker（marker 缺席 = 已提交完整版本，单向事实）→ 清 staging
    parentFs.deleteSync(markerRel);
    await parentFs.removeDir(stageName).catch(() => {
      // silent: staging 清理失败不影响已发布事实；残留 `.skill-staging-*` 可人工删
    });
    return;
  }

  // ---- existing 目标：旧版让位 + 身份核验的显式 replace ----
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

/**
 * per-skill claim + durable intent 驱动的多目标一致提交。
 * 返回各目标安装前的 exists 快照（供 Installed/Updated 输出）。
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
  const sourceFs = deps.fsFactory(opts.srcAbs);
  const manifest = computeSkillSourceManifest(sourceFs);

  let intent: SkillInstallIntent;
  let resumed = false;
  try {
    intent = {
      schema_version: 1,
      token: newShortUuid(),
      skillName: opts.skillName,
      source: opts.srcAbs,
      pid: process.pid,
      process_start_time: getProcessStartTime(process.pid),
      startedAt: new Date().toISOString(),
      manifest,
      targets: opts.targets.map((t) => ({ id: t.id, state: 'pending' as const })),
    };
    opts.claimFs.writeExclusiveSync(opts.claimRel, JSON.stringify(intent, null, 2));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    // claim 已存在：读 durable intent 判读 —— 活 holder 冲突；死 holder +
    // 同 payload 恢复；死 holder + 异 payload 显式冲突留证。
    intent = readExistingInstallIntent(opts.claimFs, opts.claimRel, opts.skillName, manifest);
    resumed = true;
  }

  for (const target of intent.targets) {
    if (target.state === 'published') continue;
    const abs = opts.targets.find((t) => t.id === target.id)?.absPath;
    if (!abs) {
      throw new CliError(
        `Install intent for skill "${opts.skillName}" references unknown target "${target.id}" ` +
        `(claim: ${opts.claimRel}); evidence preserved, not overwriting`,
      );
    }
    await publishSkillDirSwap(deps, intent.source, abs, intent.manifest);
    target.state = 'published';
    opts.claimFs.writeAtomicSync(opts.claimRel, JSON.stringify(intent, null, 2));
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
 * 判读既有 claim：活 holder → in-progress 冲突；死 holder + 同 manifest →
 * 恢复（沿用 intent，重写 holder 身份）；其余 → 显式冲突保留证据。
 */
function readExistingInstallIntent(
  claimFs: FileSystem,
  claimRel: string,
  skillName: string,
  manifest: SkillSourceManifestEntry[],
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
  if (intent.skillName !== skillName || JSON.stringify(intent.manifest) !== JSON.stringify(manifest)) {
    throw new CliError(
      `Skill "${skillName}" has an interrupted install with a different source payload ` +
      `(claim: ${claimRel}, source: ${intent.source}); evidence preserved, remove it manually to retry`,
    );
  }
  // 同 payload 恢复：接管 holder 身份后继续未完成目标
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
    console.log(`  (resumed an interrupted install; both targets now in sync)`);
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
