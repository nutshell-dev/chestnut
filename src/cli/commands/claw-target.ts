/**
 * @module L6.CLI.Claw.Target
 *
 * phase 1986 Step C：claw 命令族的 CLI 侧目标解析入口——
 * ClawTopology 位置唯一出口（resolveClawLocation）的 CLI 投影。
 * 各 verb 不再直用 L2c getClawDir/getRelativeClawDir 拼 claw 根，
 * motion 语义只经 `target.isMotion`（不出现 name === 'motion' 字面）。
 *
 * phase 1986 Step D：同文件追加存在性 helper（assertPublishedClaw /
 * assertClawDirExists）。
 */

import { getClawConfigPath, makeClawId } from '../../foundation/claw-identity/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { MOTION_CLAW_ID, resolveClawLocation } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import type { ClawCommandDeps } from './claw-command-deps.js';

export interface ClawTarget {
  readonly clawId: ClawId;
  readonly clawDir: string;
  readonly isMotion: boolean;
}

/** 位置解析入口；存在性判定在 Step D 的 helper 中。 */
export function resolveClawTarget(name: string): ClawTarget {
  const clawId = makeClawId(name);
  const location = resolveClawLocation(clawId);
  return {
    clawId,
    clawDir: location.clawDir,
    isMotion: clawId === MOTION_CLAW_ID,
  };
}

export interface PublishedClawOptions {
  /** 普通 claw 不存在时追加的提示（如 Try `chestnut claw list` ...）。 */
  readonly notFoundHint?: string;
}

/**
 * 已发布 claw 目标的存在性门（phase 1986 Step D）。
 *
 * - motion：以 `<root>/motion` 布局存在为依据（motion 无 claws/<name>/config.yaml）；
 * - 普通 claw：保持 config.yaml 为依据（半创建/未发布目录不算存在）。
 *
 * 存在性语义的唯一实现点；verb 不各自判 `target.isMotion`。
 */
export function assertPublishedClaw(
  deps: ClawCommandDeps,
  name: string,
  opts: PublishedClawOptions = {},
): ClawTarget {
  const target = resolveClawTarget(name);
  if (target.isMotion) {
    if (!deps.fsFactory(target.clawDir).existsSync('.')) {
      throw new CliError(
        `Motion is not initialized: ${target.clawDir} does not exist. Run \`chestnut start\` first.`,
      );
    }
    return target;
  }
  if (deps.rootConfig.loadClaw(getClawConfigPath(name)) === undefined) {
    throw new CliError(
      `Claw "${name}" does not exist${opts.notFoundHint ? `. ${opts.notFoundHint}` : ''}`,
    );
  }
  return target;
}

/** orphan-tolerant 命令的目录门（outbox/outbox-skip）：只要求位置存在。 */
export function assertClawDirExists(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  name: string,
): ClawTarget {
  const target = resolveClawTarget(name);
  if (!deps.fsFactory(target.clawDir).existsSync('.')) {
    throw new CliError(`Claw directory not found: ${target.clawDir}`);
  }
  return target;
}
