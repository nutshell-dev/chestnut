/**
 * @module L2c.FileTool
 * Shared sync backup helper（write / edit / multi_edit / exec_overflow 共用）
 *
 * 复用 phase 485 syncDir 装配协议 + Snapshot commit hook generic clean。
 */

import { newShortUuid } from  '../node-utils/index.js';
import { formatErr } from "../node-utils/index.js";
import * as path from 'path';
import type { ExecContext } from '../tools/index.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';
import { TASKS_SYNC_WRITE_DIR } from './constants.js';

type BackupSource = 'file_backup' | 'edit_backup' | 'multi_edit_backup' | 'exec_overflow';

/**
 * phase 2093 Step B：备份结果判别联合（私有文件级 export，仅供 write.ts /
 * edit-commit.ts 两个内部 consumer 消费，不进入模块 barrel）。
 *
 * - `created`：备份内容已由 `writeAtomic` 返回。**只代表已提交**，不代表目录
 *   耐久或断电安全（耐久性不确定仍由 FILE-TOOL-BACKUP-DURABILITY-RESULT 单独登记）。
 * - `absent` ：目标确定不存在（`fs.exists` 为 false；NodeFileSystem 仅 ENOENT
 *   返回 false），可以走「新建」路径。
 * - `failed` ：`exists` / `read` / `writeAtomic` 抛错——BACKUP_FAILED 已按原格式
 *   审计，调用方必须 fail-closed。`error` 是展示用摘要，不作为完整异常图保证。
 */
export type BackupResult =
  | { kind: 'created'; path: string }
  | { kind: 'absent' }
  | { kind: 'failed'; error: string };

export async function backupToSync(
  ctx: ExecContext,
  filePath: string,
  source: BackupSource,
): Promise<BackupResult> {
  try {
    const exists = await ctx.fs.exists(filePath);
    if (!exists) return { kind: 'absent' };
    const content = await ctx.fs.read(filePath);
    const id = newShortUuid();
    // file_backup scratch 写到 tasks/sync/write/ 子目录（phase 511 / phase772 const 归正）
    const fullPath = path.join(ctx.syncDir, TASKS_SYNC_WRITE_DIR.split('/').pop()!, `${id}.md`);
    const frontmatter = `---\nsource: ${source}\noriginal_path: ${filePath}\ncontent_length: ${content.length}\ncreated_at: ${new Date().toISOString()}\n---\n`;
    await ctx.fs.writeAtomic(fullPath, frontmatter + content);
    return { kind: 'created', path: path.relative(ctx.clawDir, fullPath) };
  } catch (err) {
    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.BACKUP_FAILED,
      `source=${source}`,
      `path=${filePath}`,
      `reason=${formatErr(err)}`,
    );
    return { kind: 'failed', error: formatErr(err) };
  }
}
