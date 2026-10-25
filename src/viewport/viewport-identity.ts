/**
 * Viewport identity → 磁盘根推导（Phase 1997 Step B）。
 *
 * identity 的唯一判据是 `ClawLocation.kind`；`label` 只是显示名，
 * 任何 `label === MOTION_CLAW_ID` 都不是身份判据（用户 claw 的目录名/
 * 显示名可以恰为 'motion' 的测试 fixture，不得被误判为系统 Motion）。
 */

import * as path from 'path';
import type { ClawLocation } from '../core/claw-topology/index.js';

/**
 * 从 typed location 推导 viewport 运行根。
 *
 * - motion：`<chestnutRoot>/motion` → chestnutRoot = dirname(clawDir)
 * - claw：`<chestnutRoot>/claws/<id>` → chestnutRoot = clawDir 上两级
 */
export function resolveViewportRoots(location: ClawLocation): {
  agentDir: string;
  chestnutRoot: string;
  isMotion: boolean;
} {
  const agentDir = location.clawDir;
  const isMotion = location.kind === 'motion'; // discriminant 比较：kind 字面 'motion' 是身份唯一判据（非 label、非目录名）
  const chestnutRoot = isMotion
    ? path.dirname(agentDir)                 // Motion-only: <chestnutRoot>/motion → <chestnutRoot>（单层上移只属 motion 布局）
    : path.resolve(agentDir, '..', '..');    // .chestnut/claws/<id> -> .chestnut
  return { agentDir, chestnutRoot, isMotion };
}
