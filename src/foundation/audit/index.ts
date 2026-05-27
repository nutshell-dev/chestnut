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
import type { FileSystem } from '../fs/types.js';

export type { AuditLog } from './types.js';
import type { AuditLog } from './types.js';

export { AuditWriter, AUDIT_FILE, reconcileFallbackDumps } from './writer.js';
export { AUDIT_MESSAGE_MAX_CHARS } from './defaults.js';
export { AUDIT_PREVIEW_LEN } from '../constants.js';
export { BatchedAuditWriter } from './batched-writer.js';
export type { BatchedAuditWriterOptions } from './batched-writer.js';

export function createSystemAudit(fs: FileSystem, baseDir: string): AuditLog {
  return new AuditWriter(fs, path.join(baseDir, AUDIT_FILE));
}

export function createAuditWriter(
  fs: FileSystem,
  filePath: string,
  maxSizeMb?: number | null,
): AuditLog {
  return new AuditWriter(fs, filePath, maxSizeMb);
}
