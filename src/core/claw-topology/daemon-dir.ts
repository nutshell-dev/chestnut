/**
 * @module L4.ClawTopology.DaemonDir
 *
 * Resolve daemonDir for a given clawId — chestnut topology 业务：
 * - motion clawId → <chestnut-root>/motion/
 * - 其他 clawId → <chestnut-root>/claws/<id>/
 *
 * clawId → 位置事实（clawDir）的唯一解析入口；DaemonDir brand 构造归 PM
 * （phase 1864 Step D / CT-D4：caller 经 PM.makeDaemonDirFromLocation）。
 * caller 不应自拼 path（CLAWS_DIR / motion 子目录约定归 L4 拓扑业务）。
 *
 * phase 694：从现 makeAgentDirResolver() factory 抽出直调入口、PM 撤
 * dirResolver 注入后 caller 改用本 helper 直算 daemonDir 再传 PM API。
 * （resolver 文件已随 phase 1893 删除：694 直调化后零运行消费。）
 */

import type { ClawId } from '../../foundation/claw-identity/index.js';
import { type DaemonDir, makeDaemonDirFromLocation } from '../../foundation/process-manager/index.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';
import { getNamedSubrootDir, getClawDir } from '../../foundation/claw-identity/index.js';

/**
 * Resolve daemonDir for one clawId.
 *
 * 返：
 * - motion clawId → `<chestnut-root>/motion/`
 * - others        → `<chestnut-root>/claws/<id>/`（含 path traversal 校验、详 claw-identity/instance-paths.ts assertSafeClawId）
 *
 * Throws：clawId 含 path traversal 字符或空（由 getClawDir 内部抛）。
 *
 * Returns DaemonDir branded string — brand 由 PM adapter（makeDaemonDirFromLocation）
 * 构造；本函数只解析位置。
 */
export function resolveClawDaemonDir(clawId: ClawId): DaemonDir {
  const clawDir = clawId === MOTION_CLAW_ID ? getNamedSubrootDir('motion') : getClawDir(clawId);
  return makeDaemonDirFromLocation({ kind: 'local', clawDir });
}
