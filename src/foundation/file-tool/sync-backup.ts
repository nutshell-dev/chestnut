/**
 * @module L2.FileTool
 * Shared sync backup helper（write / edit / multi_edit / exec_overflow 共用）
 *
 * 复用 phase 485 syncDir 装配协议 + Snapshot commit hook generic clean。
 */

import { randomUUID } from 'crypto';
import * as path from 'path';
import type { ExecContext } from '../tool-protocol/index.js';

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
    const fullPath = `${ctx.syncDir}/${id}.md`;
    const frontmatter = `---\nsource: ${source}\noriginal_path: ${filePath}\ncontent_length: ${content.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + content);
    return path.relative(ctx.clawDir, fullPath);
  } catch {
    return null;
  }
}
