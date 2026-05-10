/**
 * @module L2.FileTool
 * Shared sync backup helper（write / edit / multi_edit / exec_overflow 共用）
 *
 * 复用 phase 485 syncDir 装配协议 + Snapshot commit hook generic clean。
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import type { ExecContext } from '../tool-protocol/index.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';

export type BackupSource = 'file_backup' | 'edit_backup' | 'multi_edit_backup' | 'exec_overflow';

export async function backupToSync(
  ctx: ExecContext,
  filePath: string,
  source: BackupSource,
): Promise<string | null> {
  try {
    const exists = await ctx.fs.exists(filePath);
    if (!exists) return null;
    const content = await ctx.fs.read(filePath);
    const id = randomUUID().slice(0, 8);
    // file_backup scratch 写到 tasks/sync/write/ 子目录（phase 511）
    const fullPath = `${ctx.syncDir}/write/${id}.md`;
    const frontmatter = `---\nsource: ${source}\noriginal_path: ${filePath}\ncontent_length: ${content.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + content);
    return path.relative(ctx.clawDir, fullPath);
  } catch (err) {
    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.BACKUP_FAILED,
      `source=${source}`,
      `path=${filePath}`,
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
