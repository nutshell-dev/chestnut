/**
 * @module L2a.AuditLog.DirContext
 *
 * Generic `{ fs, audit }` pair factory.
 *
 * Moved from `foundation/process-manager/factories.ts` in phase 1397 — the
 * helper has no process-manager semantics and its callers (CLI commands,
 * watchdog context) just need an `{fs, audit}` pair scoped to an arbitrary
 * directory. Living next to the AuditWriter / createSystemAudit it actually
 * constructs (M#1: independent-responsibility-per-module).
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from './types.js';
import { AuditWriter, AUDIT_FILE } from './writer.js';

/**
 * createDirContext(dir)
 *
 * 输入：
 *   - deps.fsFactory: 构造 FileSystem 的工厂（包注入）
 *   - dir: 绝对路径；audit.tsv 所在目录
 *
 * 输出：
 *   - { fs, audit } 配对对象；每次调用返回新实例
 *   - fs: deps.fsFactory(dir)
 *   - audit: AuditWriter rooted at `${dir}/${AUDIT_FILE}` (via createSystemAudit)
 *
 * 边界：
 *   - relPath 固定为 AUDIT_FILE 常量
 *   - 不 mkdir；audit.tsv 不存在时首次 write 会创建（AuditWriter 原生行为）
 *   - 不做 retention（maxSizeMb 留空、AuditWriter 默认）
 *
 * 失败：
 *   - fsFactory / createSystemAudit ctor 抛错 → 原样上抛
 *   - audit.write 运行期失败 → AuditWriter 内部 try/catch 吞错 + console.error
 */
export function createDirContext(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  dir: string,
): { fs: FileSystem; audit: AuditLog } {
  const fs = deps.fsFactory(dir);
  const audit = new AuditWriter(fs, path.join(dir, AUDIT_FILE));
  return { fs, audit };
}
