/**
 * @module L4.ClawTopology.NotifyRouting
 *
 * phase 1864 Step B（CT-D1 + CT-D5）：安装路径 API 群（workspace/root/subroot/
 * claw dir/config/claws 枚举）已迁 foundation/claw-identity（稳定路径 owner）。
 * 本文件仅留 notify 路由（CT-D2 面、Step C 迁 Messaging）。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { INBOX_PENDING_DIR, resolveDlqDir } from '../../foundation/messaging/index.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import { InboxWriter, makeInboxPath } from '../../foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../foundation/messaging/index.js';
import type { InboxMessageOptionsBase } from '../../foundation/messaging/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CLAWS_DIR, makeClawId } from '../../foundation/claw-identity/index.js';

/**
 * phase 705: 为 L2c Messaging.notifyClaw 计算 caller 注入所需路径。
 * L4 ClawTopology 持有 chestnut 目录布局知识；Messaging 仅负责 inbox 写入协议。
 */
export function routeNotifyClaw(
  fs: FileSystem,
  chestnutRoot: string,
  motionClawId: string,
  targetClawId: string,
  message: InboxMessageOptionsBase,
  audit: AuditLog,
): void {
  // phase 944: validate targetClawId before deriving any paths
  makeClawId(targetClawId);
  const isMotion = targetClawId === motionClawId;
  const targetClawRoot = isMotion
    ? path.join(chestnutRoot, motionClawId)
    : path.join(chestnutRoot, CLAWS_DIR, targetClawId);
  const targetInboxDir = path.join(targetClawRoot, INBOX_PENDING_DIR);
  const dlqDir = isMotion ? undefined : resolveDlqDir(path.join(chestnutRoot, motionClawId, 'inbox'));
  notifyClaw(fs, targetClawRoot, targetInboxDir, dlqDir, message, audit);
}

/**
 * phase 942: async throwing variant for notify_claw tool.
 * Wraps InboxWriter.writeSync so disk failures propagate to the tool (no silent swallow).
 * Caller (tool) already validates claw existence; this variant skips DLQ routing.
 */
export async function routeNotifyClawAsync(
  fs: FileSystem,
  chestnutRoot: string,
  motionClawId: string,
  targetClawId: string,
  message: InboxMessageOptionsBase,
  audit: AuditLog,
): Promise<void> {
  // phase 944: validate targetClawId before deriving any paths
  makeClawId(targetClawId);
  const isMotion = targetClawId === motionClawId;
  const targetClawRoot = isMotion
    ? path.join(chestnutRoot, motionClawId)
    : path.join(chestnutRoot, CLAWS_DIR, targetClawId);
  const targetInboxDir = path.join(targetClawRoot, INBOX_PENDING_DIR);

  // phase 943: TOCTOU guard — the caller's exist-check may race with deletion/recreation.
  // Verify the target root actually exists before writing so we do not recreate an orphan claw directory.
  if (!fs.existsSync(targetClawRoot)) {
    throw new Error(`Target claw root does not exist: ${targetClawRoot}`);
  }

  // phase 936/937 mirror: containment + suffix checks before write
  const resolvedInbox = fs.resolve(targetInboxDir);
  const resolvedRoot = fs.resolve(targetClawRoot);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  const normalizedInbox = path.normalize(resolvedInbox);
  if (normalizedInbox !== resolvedRoot && !normalizedInbox.startsWith(rootPrefix)) {
    throw new Error(
      `notifyClaw: targetInboxDir "${targetInboxDir}" is not within targetClawRoot "${targetClawRoot}"`,
    );
  }
  const expectedSuffix = path.normalize(INBOX_PENDING_DIR);
  if (
    !normalizedInbox.endsWith(expectedSuffix) &&
    normalizedInbox !== resolvedRoot + path.sep + expectedSuffix
  ) {
    throw new Error(
      `notifyClaw: targetInboxDir must be <root>/inbox/pending, got "${targetInboxDir}"`,
    );
  }

  InboxWriter.__internal_create(fs, makeInboxPath(targetInboxDir), audit, MESSAGING_WRITER_LIMITS_DEFAULT).writeSync(message);
}
