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
  TASKS_SYNC_DIR,
  CLAW_SPEC_FILE,
  CLAW_MEMORY_FILE,
  CLAW_IDENTITY_FILE,
  CLAW_SOUL_FILE,
  CLAW_USER_FILE,
  CLAW_AUTH_POLICY_FILE,
  CLAW_HEARTBEAT_FILE,
} from './claw-files.js';

// phase 1864 Step B（CT-D1 + CT-D5）：安装路径 API 群迁入（稳定路径 owner）。
export {
  CONFIG_YAML_FILE,
  getWorkspaceRoot,
  getChestnutRoot,
  getNamedSubrootDir,
  getClawDir,
  getRelativeClawDir,
  getClawConfigPath,
  makeChestnutRoot,
  resolveChestnutRoot,
  CLAWS_DIR,
  enumerateClaws,
} from './instance-paths.js';
export type { ChestnutRoot } from './instance-paths.js';
