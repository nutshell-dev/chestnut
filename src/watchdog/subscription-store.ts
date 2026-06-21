/**
 * @module L6.Watchdog.SubscriptionStore
 * phase 5: motion-requested inactivity subscriptions — file-based (1 file per claw).
 *
 * 设计动机：
 *  - CLI (watch verb) 与 watchdog daemon 跨进程 / 不能共享 in-memory Map
 *  - 各自写 watchdog-state.json 会 race
 *  - 改用 dir-of-files：每订阅 1 atomic file / claw_id 作 filename / latest 写 win
 *  - watchdog cron tick 扫 dir → 处理 → 删除 (consume) 是 atomic per-file
 *  - 文件天然 persist 跨 watchdog 重启
 *
 * 文件路径：`<chestnut dir>/watchdog-subscriptions/<clawId>.json`
 * 文件内容：JSON `{ subscribed_at: number, threshold_ms: number }`
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from '../foundation/utils/index.js';

export const SUBSCRIPTION_DIR = 'watchdog-subscriptions';
export const MAX_THRESHOLD_MS = 24 * 60 * 60 * 1000;   // 24h

export interface InactivitySubscription {
  subscribed_at: number;
  threshold_ms: number;
}

export interface StoredSubscription extends InactivitySubscription {
  clawId: string;
}

function subscriptionPath(clawId: string): string {
  return path.join(SUBSCRIPTION_DIR, `${clawId}.json`);
}

/**
 * Write subscription file atomically. CLI 调 (phase 5 claw-watch).
 * Existing file for same claw → overwrite (latest wins).
 */
export function writeSubscription(
  fs: FileSystem,
  clawId: string,
  sub: InactivitySubscription,
): void {
  if (sub.threshold_ms > MAX_THRESHOLD_MS) {
    throw new Error(`threshold_ms ${sub.threshold_ms} exceeds 24h limit ${MAX_THRESHOLD_MS}`);
  }
  fs.ensureDirSync(SUBSCRIPTION_DIR);
  fs.writeAtomicSync(subscriptionPath(clawId), JSON.stringify(sub));
}

/** List all subscriptions (watchdog cron tick 调). Returns empty if dir missing. */
export function listSubscriptions(
  fs: FileSystem,
  audit?: AuditLog,
): StoredSubscription[] {
  let files: string[];
  try {
    files = fs.listSync(SUBSCRIPTION_DIR, { includeDirs: false })
      .map(e => e.name)
      .filter(n => n.endsWith('.json'));
  } catch (err) {
    if (isFileNotFound(err)) return [];
    audit?.write(
      WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_DIR_LIST_FAILED,
      `error=${formatErr(err)}`,
    );
    return [];  // 非 ENOENT treat as empty + audit（recovery + observability、watchdog 不死）
  }
  const result: StoredSubscription[] = [];
  for (const fname of files) {
    const clawId = fname.slice(0, -'.json'.length);
    try {
      const raw = fs.readSync(path.join(SUBSCRIPTION_DIR, fname));
      const parsed = JSON.parse(raw) as Partial<InactivitySubscription>;
      if (typeof parsed.subscribed_at === 'number' && typeof parsed.threshold_ms === 'number') {
        result.push({ clawId, subscribed_at: parsed.subscribed_at, threshold_ms: parsed.threshold_ms });
      }
      // malformed → skip (will be cleaned up next consume of any other subscription)
    } catch (err) {
      // phase 135: emit SUBSCRIPTION_CORRUPT audit（DP「不丢弃静默」、既存 const 未用、本 phase 激活）
      audit?.write(
        WATCHDOG_AUDIT_EVENTS.SUBSCRIPTION_CORRUPT,
        `fname=${fname}`,
        `error=${formatErr(err)}`,
      );
      // race (CLI writing while we read) / corrupted file → ignored this tick + audit emit
    }
  }
  return result;
}

/** Delete subscription file (consume). Idempotent — missing file is success. */
export function consumeSubscription(fs: FileSystem, clawId: string): void {
  try {
    fs.deleteSync(subscriptionPath(clawId));
  } catch (err) {
    if (isFileNotFound(err)) return;
    throw err;
  }
}

/** Resolve subscription dir absolute path for callers needing it. */
export function subscriptionDirAbs(baseDir: string): string {
  return path.join(baseDir, SUBSCRIPTION_DIR);
}
