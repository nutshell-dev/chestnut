/**
 * @module L4.ClawTopology.NotifyTarget
 *
 * notify 目标位置解析 — 拓扑 owner 只出「位置/路由事实」：
 * motion claw 在 `<chestnutRoot>/motion`、其余 claw 在 `<chestnutRoot>/claws/<id>`，
 * inbox 位置与 DLQ 落点随目标类型派生。
 *
 * phase 1864 Step C（CT-D2）：routeNotifyClaw/Async 的发送执行迁 Messaging
 * （foundation/messaging/claw-notify.ts）；本模块只提供注入用 resolver。
 * phase 944 的 id 前置校验随解析保留（非法 id 在推导任何路径之前抛错）。
 */

import * as path from 'path';
import { INBOX_PENDING_DIR, resolveDlqDir } from '../../foundation/messaging/index.js';
import type { ClawNotifyTarget, ClawNotifyTargetResolver } from '../../foundation/messaging/index.js';
import { CLAWS_DIR, makeClawId } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from './motion-claw-id.js';

/**
 * Build a caller-bindable target resolver for one chestnut root.
 *
 * 返回 fn：
 * - motion target → `<chestnutRoot>/motion`（无 DLQ）
 * - others        → `<chestnutRoot>/claws/<id>`（DLQ 落 motion inbox dead-letter）
 */
export function makeClawNotifyTargetResolver(chestnutRoot: string): ClawNotifyTargetResolver {
  return (targetClawId: string): ClawNotifyTarget => {
    // phase 944: validate targetClawId before deriving any paths
    const clawId = makeClawId(targetClawId);
    const isMotion = clawId === MOTION_CLAW_ID;
    const clawRoot = isMotion
      ? path.join(chestnutRoot, MOTION_CLAW_ID)
      : path.join(chestnutRoot, CLAWS_DIR, clawId);
    return {
      clawRoot,
      inboxDir: path.join(clawRoot, INBOX_PENDING_DIR),
      dlqDir: isMotion
        ? undefined
        : resolveDlqDir(path.join(chestnutRoot, MOTION_CLAW_ID, 'inbox')),
    };
  };
}
