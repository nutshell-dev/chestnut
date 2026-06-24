/**
 * @module L2c.ClawIdentity
 *
 * Claw 身份原语 — 单个 claw 的标识类型 + 命名约定。
 * architecture.md §18 ClawIdentity。
 * phase 705 立，ClawId 自 foundation/identity/ 迁入；
 * CLAWSPACE_DIR + CLAW_*_FILE 自 foundation/claw-paths.ts 迁入。
 */

export type { ClawId } from './claw-id.js';
export { makeClawId } from './claw-id.js';

export {
  CLAWSPACE_DIR,
  CLAW_SPEC_FILE,
  CLAW_MEMORY_FILE,
  CLAW_IDENTITY_FILE,
  CLAW_SOUL_FILE,
  CLAW_USER_FILE,
  CLAW_AUTH_POLICY_FILE,
  CLAW_HEARTBEAT_FILE,
} from './claw-files.js';
