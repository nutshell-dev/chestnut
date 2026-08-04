import { createAuditWriter, AUDIT_FILE, readWorkspaceAuditRetentionMaxSizeMb } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { getChestnutFs, getAuditWriter, setAuditWriter } from './watchdog-context.js';

/**
 * Lazy-init workspace audit writer for CLI-side watchdog operations.
 * No-op if already wired (e.g. daemon process that called setAuditWriter).
 * Fail-soft: logs to console on error, never throws.
 */
export function ensureAuditWired(fsFactory: (baseDir: string) => FileSystem): void {
  if (getAuditWriter() !== null) return;
  try {
    // Phase 1288 Step B: retention 自 AuditLog 自家 config store 读取
    const auditMaxSizeMb = readWorkspaceAuditRetentionMaxSizeMb(getChestnutFs(fsFactory));
    const auditWriter = createAuditWriter(getChestnutFs(fsFactory), AUDIT_FILE, auditMaxSizeMb);
    setAuditWriter(auditWriter);
  } catch (err) {
    console.error('Failed to wire watchdog audit in CLI:', err);
  }
}
