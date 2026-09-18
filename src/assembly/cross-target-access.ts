/**
 * @module L6.Assembly.CrossTargetAccess
 * @layer L6 装配层
 *
 * phase 1864 Step G（CT-D10）：跨目标访问 capability 的装配期构造。
 *
 * 授权主体（grantedBy）与 target 面 checker 策略在装配期确定；cross-claw adapter
 * 只消费 capability，不再隐式沿用 caller 的 claw-scoped permissionChecker。
 * checker 按 target 构造（claw-scoped 语义：targetClawDir + target fs）。
 */

import { createClawPermissionChecker } from '../core/permissions/index.js';
import type { CrossTargetAccess } from '../core/claw-topology/index.js';
import type { AuditLog } from '../foundation/audit/index.js';

export function createCrossTargetAccess(opts: {
  /** 授权主体标签（装配期决定：motion 面 / 普通 agent 面）。 */
  grantedBy: string;
  /** deny/bypass 事件必须可观察（createClawPermissionChecker 构造期必需）。 */
  audit: AuditLog;
}): CrossTargetAccess {
  const { grantedBy, audit } = opts;
  return {
    grantedBy,
    createChecker: ({ clawDir, fs }) =>
      createClawPermissionChecker({ clawDir, fs, audit, strict: true }),
  };
}
