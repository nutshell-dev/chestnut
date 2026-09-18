/**
 * @module L4.SummonSystem.LegacyStateDetection
 * phase 281 Step B: boot reconcile scan for leftover summon-state/ files.
 *
 * summon-state-store.ts 已删，旧 summon-state/ 目录残留文件不会自动清理。
 * 本 helper 在装配期扫描一次并 emit audit，供运维感知后手动 cleanup。
 * 不删文件（独立 micro-phase 负责）。
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { SUMMON_AUDIT_EVENTS } from './audit-events.js';

const SUMMON_STATE_SUBDIR = 'summon-state';

/** phase 1866 Step H（SU-D8）：legacy 扫描报告（scanned=false = 扫描不可用）。 */
export interface LegacySummonStateScan {
  readonly scanned: boolean;
  readonly leftover: number;
}

/**
 * 扫 summon-state/ 残留（装配期/恢复入口一次性观察）。
 * 行为不变（audit 行逐字不变）；phase 1866 Step H 起返回 typed 报告供恢复入口汇总。
 */
export async function checkLegacySummonStateFiles(
  fs: FileSystem,
  audit?: AuditLog,
): Promise<LegacySummonStateScan> {
  if (!audit) return { scanned: false, leftover: 0 };

  let exists: boolean;
  try {
    exists = await fs.exists(SUMMON_STATE_SUBDIR);
  } catch (err) {
    if ((err as { code?: string })?.code === 'FS_NOT_FOUND') return { scanned: true, leftover: 0 }; // dir absent → no legacy state
    audit.write(
      SUMMON_AUDIT_EVENTS.SUMMON_LEGACY_STATE_FILE_DETECTED,
      `dir=${SUMMON_STATE_SUBDIR}`,
      `error=exists_failed`,
      `reason=${formatErr(err)}`,
    );
    return { scanned: false, leftover: 0 };
  }
  if (!exists) return { scanned: true, leftover: 0 };

  let entries: { name: string }[];
  try {
    entries = await fs.list(SUMMON_STATE_SUBDIR, { includeDirs: false });
  } catch (err) {
    if ((err as { code?: string })?.code === 'FS_NOT_FOUND') return { scanned: true, leftover: 0 };
    audit.write(
      SUMMON_AUDIT_EVENTS.SUMMON_LEGACY_STATE_FILE_DETECTED,
      `dir=${SUMMON_STATE_SUBDIR}`,
      `error=list_failed`,
      `reason=${formatErr(err)}`,
    );
    return { scanned: false, leftover: 0 };
  }
  if (entries.length === 0) return { scanned: true, leftover: 0 };

  audit.write(
    SUMMON_AUDIT_EVENTS.SUMMON_LEGACY_STATE_FILE_DETECTED,
    `count=${entries.length}`,
    `dir=${SUMMON_STATE_SUBDIR}`,
    `action=manual_cleanup_required`,
  );
  return { scanned: true, leftover: entries.length };
}
