/**
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
 * （Phase 148 审定；依赖 AuditLog 的其他 L2 模块不得效仿）。
 */

import { AuditWriter } from './writer.js';
import * as path from 'path';
import type { FileSystem } from '../fs/types.js';

export interface Audit {
  write(type: string, ...cols: (string | number)[]): void;
}

export { AuditWriter } from './writer.js';

export function createSystemAudit(fs: FileSystem, baseDir: string): Audit {
  return new AuditWriter(fs, path.join(baseDir, 'audit.tsv'));
}
