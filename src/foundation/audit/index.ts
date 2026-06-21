// phase 478: _helpers clip functions barrel re-export
export { clipPreview, clipMessage, clipSummary } from './_helpers.js';

/**
 * @module L2.AuditLog
 * AuditLog module (L2)
 *
 * 状态迁移审计记录。纯追加写。
 * 服务于"运行中产生的所有信息全量记录以供审计"。
 *
 * Resources: audit.tsv
 * Dependencies: FileSystem
 * Coupling: none
 * Consumers: Daemon, Runtime, ContractSystem, SubagentSystem
 *
 * 递归边界：AuditWriter 自身 write/rotation 失败是"审计的审计"死角，
 * 无法进入结构化事件流（会无限递归），唯一兜底是 console.error
 * 以 [AUDIT CRITICAL] 前缀输出。这是 L2 层唯一允许保留的 console 出口
 * （依赖 AuditLog 的其他 L2 模块不得效仿）。
 */

import { AuditWriter, AUDIT_FILE } from './writer.js';
import * as path from 'path';
import type { FileSystem } from '../fs/index.js';

export type { AuditLog, IdNamingEntry, ColSchemaEntry, TraceId } from './types.js';
export { makeTraceId } from './types.js';
import type { AuditLog } from './types.js';

export { AuditWriter, AUDIT_FILE, reconcileFallbackDumps } from './writer.js';
export { createDirContext } from './dir-context.js';
import { DispatchingAuditWriter } from './dispatching-writer.js';
export { DispatchingAuditWriter };

export function createSystemAudit(
  fs: FileSystem,
  baseDir: string,
  options?: { typeToFile?: ReadonlyMap<string, string>; maxSizeMb?: number | null },
): AuditLog {
  if (options?.typeToFile && options.typeToFile.size > 0) {
    return new DispatchingAuditWriter(fs, baseDir, options.typeToFile, {
      maxSizeMb: options.maxSizeMb,
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

// Reader API (phase 126 + phase 147)
export {
  createAuditReader,
  listAuditFiles,
  listPendingFallbackDumps,
} from './reader.js';
export type {
  AuditRecord,
  ReadOptions,
  AuditFileInfo,
  LookupResult,
  LookupOptions,
} from './reader.js';
