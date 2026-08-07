import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { AuditWriter, AUDIT_FILE } from './writer.js';
import { DispatchingAuditWriter } from './dispatching-writer.js';
import type { AuditFileName, AuditLog } from './types.js';

export function createSystemAudit(
  fs: FileSystem,
  baseDir: string,
  options?: { typeToFile?: ReadonlyMap<string, AuditFileName>; maxSizeMb?: number | null; tickRetentionDays?: number | null },
): AuditLog {
  if (options?.typeToFile && options.typeToFile.size > 0) {
    return new DispatchingAuditWriter(fs, baseDir, options.typeToFile, {
      maxSizeMb: options.maxSizeMb,
      tickRetentionDays: options.tickRetentionDays,
    });
  }
  // 向后兼容：无 spec → 单 AuditWriter to audit.tsv
  return new AuditWriter(fs, path.join(baseDir, AUDIT_FILE), options?.maxSizeMb);
}

export function createAuditWriter(
  fs: FileSystem,
  filePath: string,
  maxSizeMb?: number | null,
): AuditLog {
  return new AuditWriter(fs, filePath, maxSizeMb);
}
