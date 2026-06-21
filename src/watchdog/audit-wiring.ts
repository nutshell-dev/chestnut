import { createAuditWriter, AUDIT_FILE } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { getChestnutFs, getGlobalConfig, getAuditWriter, setAuditWriter } from './watchdog-context.js';

/**
 * Lazy-init workspace audit writer for CLI-side watchdog operations.
 * No-op if already wired (e.g. daemon process that called setAuditWriter).
 * Fail-soft: logs to console on error, never throws.
 */
export function ensureAuditWired(fsFactory: (baseDir: string) => FileSystem): void {
  if (getAuditWriter() !== null) return;
  try {
    const auditMaxSizeMb = getGlobalConfig(fsFactory).audit.retention.max_size_mb;
    const auditWriter = createAuditWriter(getChestnutFs(fsFactory), AUDIT_FILE, auditMaxSizeMb);
    setAuditWriter(auditWriter);
  } catch (err) {
    console.error('Failed to wire watchdog audit in CLI:', err);
  }
}
