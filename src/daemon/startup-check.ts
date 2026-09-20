/**
 * @module L6.Daemon.StartupCheck
 * @layer L6 进程边界
 * @depends L1.FileSystem
 * @consumers L6.DaemonLoop
 *
 * daemon 启动后是否 emit `startup_check` inbox 消息的决策逻辑。
 * 3 个 fs 状态 check：inbox empty + active contracts + cooldown elapsed。
 * phase 1838: 不再按文件名 dedup（`_startup_check_` 从未出现在真实文件名中）；
 * 投递确认改由 daemon-loop 以 startup_check_ts 关联消息真实记录完成。
 */

import * as path from 'path';
import { isFileNotFound, type FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { hasActiveContract } from '../core/contract/index.js';
import { STATUS_SUBDIR } from '../foundation/process-manager/index.js';
import { peekPendingCount } from '../foundation/messaging/index.js';
import { STARTUP_CHECK_COOLDOWN_MS, DAEMON_STATE_DIR, STARTUP_CHECK_TS_FILE } from './constants.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from '../foundation/node-utils/index.js';

/** inbox 目录是否 0 个 .md 文件。I/O 错误 → 假定非空（fail-closed，不跳过 startup check）。*/
export function isInboxEmpty(fs: FileSystem, audit: AuditLog): boolean {
  const result = peekPendingCount(fs, '.');
  if (!result.ok) {
    audit.write(
      DAEMON_AUDIT_EVENTS.STARTUP_CHECK_IO_ERROR,
      `fn=peekPendingCount`,
      `reason=${result.error}`,
    );
    return false;
  }
  return result.value === 0;
}

/** 是否有活跃 contract（contracts/active 目录下有子目录）。读失败默 false（保守假定无活跃）。*/
function hasActiveContracts(fs: FileSystem, audit: AuditLog): boolean {
  try {
    return hasActiveContract(fs, '.');
  } catch (err) {
    // phase 851: I/O 错误不再静默吞没，emit audit 保持可观察
    audit.write(
      DAEMON_AUDIT_EVENTS.STARTUP_CHECK_IO_ERROR,
      `fn=hasActiveContracts`,
      `reason=${formatErr(err)}`,
    );
    return false;
  }
}

/**
 * startup cooldown 分类（phase 1873 Step H：cooldown 判定与「证据调和」拆开——
 * fresh 态由 caller（daemon-loop）经消息证据调和，避免「提交后崩溃未投递」被静默压制）。
 *
 * - none：无 ts 文件（首次 / corrupt 已清 / 非 ENOENT 读取失败按无冷却处理）；
 * - cooled：ts 已过 cooldown；
 * - fresh：ts 在 cooldown 内——caller 需核对消息证据决定压制或重投递。
 *
 * phase 1873 Step G：状态归 daemon-owned 路径（`daemon/startup_check_ts`）。
 * legacy 兼容（迁移期显式）：新路径缺失时读旧 `status/startup_check_ts`（PM 目录）——
 * 读到旧值则以旧值为准判定 + 迁移写新路径；旧文件不主动删除（避免跨版本双跑丢状态；
 * 退役条件：无旧版本进程写 legacy 路径后另行清理）。
 */
export type StartupCheckCooldown =
  | { kind: 'none' }
  | { kind: 'cooled' }
  | { kind: 'fresh'; ts: number };

export function classifyStartupCheckCooldown(fs: FileSystem, audit: AuditLog): StartupCheckCooldown {
  const newRel = path.join(DAEMON_STATE_DIR, STARTUP_CHECK_TS_FILE);
  const legacyRel = path.join(STATUS_SUBDIR, STARTUP_CHECK_TS_FILE);

  let raw: string;
  let readFrom: 'daemon' | 'legacy' = 'daemon';
  try {
    raw = fs.readSync(newRel).trim();
  } catch (err) {
    if (!isFileNotFound(err)) {
      // phase 851: I/O 错误不再静默吞没，emit audit 保持可观察
      audit.write(
        DAEMON_AUDIT_EVENTS.STARTUP_CHECK_IO_ERROR,
        `fn=classifyStartupCheckCooldown`,
        `reason=${formatErr(err)}`,
      );
      return { kind: 'none' };
    }
    // 新路径缺失 → legacy 兼容读
    try {
      raw = fs.readSync(legacyRel).trim();
      readFrom = 'legacy';
    } catch (legacyErr) {
      if (!isFileNotFound(legacyErr)) {
        audit.write(
          DAEMON_AUDIT_EVENTS.STARTUP_CHECK_IO_ERROR,
          `fn=classifyStartupCheckCooldown(legacy)`,
          `reason=${formatErr(legacyErr)}`,
        );
      }
      return { kind: 'none' };
    }
  }

  const ts = parseInt(raw, 10);
  if (isNaN(ts) || ts < 0) {
    // corrupt — 视为无 cooldown（remove 读取来源文件；无状态可失）
    fs.deleteSync(readFrom === 'legacy' ? legacyRel : newRel);
    return { kind: 'none' };
  }
  if (readFrom === 'legacy') {
    // 迁移写：旧值继续生效的同时落新路径（后续启动读新路径）；失败 audit、不阻断本次判定。
    try {
      fs.ensureDirSync(DAEMON_STATE_DIR);
      fs.writeAtomicSync(newRel, String(ts));
    } catch (migrateErr) {
      audit.write(
        DAEMON_AUDIT_EVENTS.STARTUP_CHECK_IO_ERROR,
        `fn=classifyStartupCheckCooldown(migrate)`,
        `reason=${formatErr(migrateErr)}`,
      );
    }
  }
  return Date.now() - ts >= STARTUP_CHECK_COOLDOWN_MS ? { kind: 'cooled' } : { kind: 'fresh', ts };
}

/**
 * evidence 无关的同步前置：inbox empty + 有 active contract。
 * （inbox empty 已覆盖一切 pending 消息；本条目不负责单次投递去重——见模块头。）
 * cooldown 与证据调和见 classifyStartupCheckCooldown + daemon-loop 的 H 步逻辑。
 */
export function startupCheckEnvironmentEligible(fs: FileSystem, audit: AuditLog): boolean {
  return isInboxEmpty(fs, audit) && hasActiveContracts(fs, audit);
}
