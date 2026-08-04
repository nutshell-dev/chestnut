import { createWorkspaceAudit } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { getChestnutDir, getAuditWriter, setAuditWriter } from './watchdog-context.js';

/**
 * Lazy-init workspace audit writer for CLI-side watchdog operations.
 * No-op if already wired (e.g. daemon process that called setAuditWriter).
 * Fail-soft: logs to console on error, never throws.
 *
 * Phase 1288 Step C: 构造委托 AuditLog 自家 createWorkspaceAudit（固定写
 * audit/audit.tsv、retention 自 AuditLog config store 自读）；Watchdog 不再
 * 接触路径 / maxSizeMb / Assembly config。
 */
export function ensureAuditWired(fsFactory: (baseDir: string) => FileSystem): void {
  if (getAuditWriter() !== null) return;
  try {
    setAuditWriter(createWorkspaceAudit(fsFactory, getChestnutDir()));
  } catch (err) {
    console.error('Failed to wire watchdog audit in CLI:', err);
  }
}
