/**
 * @module L4.ClawTopology.DaemonDir
 *
 * Resolve daemonDir for a given clawId — chestnut topology 业务：
 * - motion clawId → <chestnut-root>/motion/
 * - 其他 clawId → <chestnut-root>/claws/<id>/
 *
 * 是 L2a ProcessManager API 入参 `daemonDir: string` 的唯一构造入口。
 * caller 不应自拼 path（CLAWS_DIR / motion 子目录约定归 L4 拓扑业务）。
 *
 * phase 694：从现 makeAgentDirResolver() factory 抽出直调入口、PM 撤
 * dirResolver 注入后 caller 改用本 helper 直算 daemonDir 再传 PM API。
 */

import type { ClawId } from '../../foundation/claw-identity/index.js';
import { type DaemonDir, makeDaemonDir } from '../../foundation/process-manager/index.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';
import { getNamedSubrootDir, getClawDir } from '../../foundation/config/index.js';

/**
 * Resolve daemonDir for one clawId.
 *
 * 返：
 * - motion clawId → `<chestnut-root>/motion/`
 * - others        → `<chestnut-root>/claws/<id>/`（含 path traversal 校验、详 claw-instance-paths.ts assertSafeClawId）
 *
 * Throws：clawId 含 path traversal 字符或空（由 getClawDir 内部抛）。
 *
 * Returns DaemonDir branded string — PM API 强制 caller 必经此函数构造。
 */
export function resolveClawDaemonDir(clawId: ClawId): DaemonDir {
  const dir = clawId === MOTION_CLAW_ID ? getNamedSubrootDir('motion') : getClawDir(clawId);
  return makeDaemonDir(dir);
}
