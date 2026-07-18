/**
 * @module L6.Assembly
 * 启动期临时残片清理（A.p320-2 / phase397）
 *
 * 启动期一次性清理 .tmp_* 残片 / 装配方副作用 / 不在 L1 fs OS 原语层。
 * 历史：phase397 物理迁 src/foundation/fs/atomic.ts → src/assembly/cleanup.ts。
 */
import * as path from 'node:path';
import type { FileSystem } from '../foundation/fs/index.js';
import { IGNORE_PATTERN } from '../foundation/fs/atomic.js';

export async function cleanupOrphanedTemp(
  fs: FileSystem,
  dirPath: string,
  olderThanMs?: number,
): Promise<string[]> {
  const cleaned: string[] = [];
  try {
    const entries = await fs.list(dirPath, { includeDirs: true });
    for (const entry of entries) {
      if (!entry.name.startsWith(IGNORE_PATTERN)) continue;
      if (!entry.isFile) continue;
      // 仅删除早于启动时间的孤儿文件（olderThanMs 未传时保持原行为）
      if (olderThanMs !== undefined) {
        try {
          const stat = await fs.stat(path.join(dirPath, entry.name));
          if (stat.mtime.getTime() >= olderThanMs) continue;
        } catch {
          continue;
        }
      }
      const fullPath = path.join(dirPath, entry.name);
      try {
        await fs.delete(fullPath);
        cleaned.push(fullPath);
      } catch (err) {
        // FS_NOT_FOUND: concurrent unlink race / file already deleted / acceptable
        // non-FS_NOT_FOUND (EACCES/EIO/ENOSPC): throw → caller .catch + audit (assemble.ts CLEANUP_TEMP_FILES_FAILED)
        if ((err as { code?: string })?.code === 'FS_NOT_FOUND') continue;
        throw err;
      }
    }
  } catch (err) {
    // FS_NOT_FOUND: first-run dir does not exist / acceptable
    // non-FS_NOT_FOUND (EACCES/EIO/EBADF): throw → caller .catch + audit (assemble.ts CLEANUP_TEMP_FILES_FAILED)
    if ((err as { code?: string })?.code === 'FS_NOT_FOUND') return cleaned;
    throw err;
  }
  return cleaned;
}
