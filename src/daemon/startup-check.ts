/**
 * @module L6.Daemon.StartupCheck
 * @layer L6 进程边界
 * @depends L1.FileSystem
 * @consumers L6.DaemonLoop
 *
 * daemon 启动后是否 emit `startup_check` inbox 消息的决策逻辑。
 * 4 个 fs 状态 check：inbox empty + active contracts + no pending + cooldown elapsed。
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { CONTRACT_DIR } from '../core/contract/index.js';
import { STATUS_SUBDIR } from '../foundation/process-manager/index.js';
import { INBOX_PENDING_DIR } from '../foundation/messaging/index.js';
import { STARTUP_CHECK_COOLDOWN_MS } from './constants.js';

/** inbox 目录是否 0 个 .md 文件。读失败默 true（保守假定非空）。*/
export function isInboxEmpty(fs: FileSystem): boolean {
  try {
    return fs.listSync(INBOX_PENDING_DIR).filter(e => e.name.endsWith('.md')).length === 0;
  } catch {
    return true;
  }
}

/** 是否有活跃 contract（contracts/active 目录下有子目录）。读失败默 false（保守假定无活跃）。*/
export function hasActiveContracts(fs: FileSystem): boolean {
  try {
    return fs.listSync(path.join(CONTRACT_DIR, 'active'), { includeDirs: true }).some(e => e.isDirectory);
  } catch {
    return false;
  }
}

/** inbox 是否已有 pending 的 _startup_check_ 文件（dedup 用）。读失败默 false。*/
export function hasPendingStartupCheck(fs: FileSystem): boolean {
  try {
    return fs.listSync(INBOX_PENDING_DIR).map(e => e.name).some(f => f.includes('_startup_check_'));
  } catch {
    return false;
  }
}

/** startup_check_ts 文件是否过 cooldown。读失败 / 解析失败 / 负值 → 默 true（无 cooldown）。*/
export function isStartupCheckCooledDown(fs: FileSystem): boolean {
  try {
    const raw = fs.readSync(path.join(STATUS_SUBDIR, 'startup_check_ts')).trim();
    const ts = parseInt(raw, 10);
    if (isNaN(ts) || ts < 0) {
      // corrupt — treat as cooled down (remove file)
      fs.deleteSync(path.join(STATUS_SUBDIR, 'startup_check_ts'));
      return true;
    }
    return Date.now() - ts >= STARTUP_CHECK_COOLDOWN_MS;
  } catch {
    return true;
  }
}

/**
 * 决策是否 emit startup_check inbox 消息。
 * 4 条件全 true 才 emit：inbox empty + has active + 无 pending startup_check + cooldown 过。
 */
export function shouldEmitStartupCheck(fs: FileSystem): boolean {
  return (
    isInboxEmpty(fs) &&
    hasActiveContracts(fs) &&
    !hasPendingStartupCheck(fs) &&
    isStartupCheckCooledDown(fs)
  );
}
