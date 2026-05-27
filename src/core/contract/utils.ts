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
import { isFileNotFound, type FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { CONTRACT_DIR } from './dirs.js';

import { emitContractContractDirScanFailed } from './audit-emit.js';
import { type ClawDir } from '../../foundation/identity/index.js';

const EPOCH_2020_01_01_MS = 1_577_836_800_000;

/** 返回当前活跃/暂停契约的创建时间（毫秒），无契约时返回 null */
export function getContractCreatedMs(
  fs: FileSystem,
  clawDir: ClawDir,
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
      // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
      if (!isFileNotFound(err) && audit) {
        const code = (err as NodeJS.ErrnoException)?.code;
        emitContractContractDirScanFailed(
          audit,
          {
            dir: sub,
            code: code ?? 'unknown',
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
  }
  return null;
}
