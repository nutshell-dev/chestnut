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

import { makeClawId } from '../../foundation/claw-identity/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID, resolveClawLocation } from '../../core/claw-topology/index.js';

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
