/**
 * @module L4.ClawTopology.Location
 *
 * claw identity 的磁盘位置事实的唯一解析出口。
 *
 * - motion：`<chestnutRoot>/motion`（系统根 claw，不在 claws/ 容器内）
 * - claw：`<chestnutRoot>/claws/<id>`
 *
 * caller 不自行拼 `claws/<name>`、不判 `motion` 字面；motion 语义的
 * 唯一 discriminant 是 `ClawLocation.kind`。
 *
 * phase 1986 Step B：自 daemon-dir.ts 的 motion 三元式抽出为通用出口；
 * CLI 资源路径与 audit 落点统一消费本出口（Step C）。
 */

import { getClawDir, getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';

/**
 * claw identity 的磁盘位置事实。
 *
 * - motion：`<chestnutRoot>/motion`（系统根 claw，不在 claws/ 容器内）
 * - claw：`<chestnutRoot>/claws/<id>`
 *
 * 这是位置解析唯一出口；caller 不自行拼 `claws/<name>`、不判 `motion` 字面。
 */
export type ClawLocation =
  | { readonly kind: 'motion'; readonly clawDir: string }
  | { readonly kind: 'claw'; readonly clawDir: string };

export function resolveClawLocation(clawId: ClawId): ClawLocation {
  return clawId === MOTION_CLAW_ID
    ? { kind: 'motion', clawDir: getNamedSubrootDir(MOTION_CLAW_ID) }
    : { kind: 'claw', clawDir: getClawDir(clawId) };
}
