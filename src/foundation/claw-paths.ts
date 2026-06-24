/**
 * @module L2.ClawPaths
 *
 * Backward-compat barrel（phase 705）。
 *
 * 原常量已拆分归属：
 * - CLAWSPACE_DIR + CLAW_*_FILE ×7 → L2c.ClawIdentity（src/foundation/claw-identity/）
 * - CLAWS_DIR + enumerateClaws → L4.ClawTopology（src/core/claw-topology/claw-instance-paths.ts）
 *
 * 本文件保留 re-export，避免下游调用方/测试级联改动；后续 cleanup phase 删除。
 */

export {
  CLAWSPACE_DIR,
  CLAW_SPEC_FILE,
  CLAW_MEMORY_FILE,
  CLAW_IDENTITY_FILE,
  CLAW_SOUL_FILE,
  CLAW_USER_FILE,
  CLAW_AUTH_POLICY_FILE,
  CLAW_HEARTBEAT_FILE,
} from './claw-identity/claw-files.js';

export { CLAWS_DIR, enumerateClaws } from '../core/claw-topology/claw-instance-paths.js';
