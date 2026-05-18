/**
 * @module L4.ContractUtils
 * @layer L4 业务层（Contract 工具函数）
 * @depends L1.FileSystem
 * @consumers L6.Watchdog, L6.ChatViewport
 * @contract design/modules/l4_contract_system.md
 *
 * Contract directory inspection utilities (read-only).
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CONTRACT_DIR } from './dirs.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

const EPOCH_2020_01_01_MS = 1_577_836_800_000;

/** 返回当前活跃/暂停契约的创建时间（毫秒），无契约时返回 null */
export function getContractCreatedMs(
  fs: FileSystem,
  clawDir: string,
  audit?: AuditLog,
): number | null {
  for (const sub of ['active', 'paused']) {
    try {
      const entries = fs.listSync(
        path.join(clawDir, CONTRACT_DIR, sub),
        { includeDirs: true },
      );
      for (const e of entries) {
        if (!e.isDirectory) continue;
        const ts = parseInt(e.name.split('-')[0], 10);
        // 合理的毫秒时间戳：> 2020-01-01
        if (!isNaN(ts) && ts > EPOCH_2020_01_01_MS) return ts;
      }
    } catch (err) {
      // phase 1010 r123 B fork: narrow ENOENT 兑现 first-run state 注释意图、非 ENOENT audit
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && audit) {
        audit.write(
          CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED,
          `dir=${sub}`,
          `code=${code ?? 'unknown'}`,
          `error=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return null;
}
