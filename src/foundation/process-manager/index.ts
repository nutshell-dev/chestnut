/**
 * ProcessManager module (L2)
 *
 * 进程生命周期管理。spawn、stop、存活检查、PID 文件管理。
 * 依赖：FileSystem
 */
import * as path from 'path';
import { AuditWriter } from '../audit/writer.js';
import type { FileSystem } from '../fs/types.js';
import type { Audit } from '../audit/index.js';

export function createSystemAudit(fs: FileSystem, baseDir: string): Audit {
  return new AuditWriter(fs, path.join(baseDir, 'audit.tsv'));
}

export { ProcessManager } from './manager.js';
export type { SpawnOptions } from './manager.js';
