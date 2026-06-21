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
import { SUMMON_AUDIT_EVENTS } from './audit-events.js';

const SUMMON_STATE_SUBDIR = 'summon-state';

export async function checkLegacySummonStateFiles(
  fs: FileSystem,
  audit?: AuditLog,
): Promise<void> {
  if (!audit) return;

  const exists = await fs.exists(SUMMON_STATE_SUBDIR).catch(() => false);
  if (!exists) return;

  const entries = await fs.list(SUMMON_STATE_SUBDIR, { includeDirs: false }).catch(() => []);
  if (entries.length === 0) return;

  audit.write(
    SUMMON_AUDIT_EVENTS.SUMMON_LEGACY_STATE_FILE_DETECTED,
    `count=${entries.length}`,
    `dir=${SUMMON_STATE_SUBDIR}`,
    `action=manual_cleanup_required`,
  );
}
