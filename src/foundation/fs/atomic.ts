/**
 * Atomic file operations
 * 
 * - writeAtomic: write to temp file + rename (atomic on POSIX)
 * - All operations use fs/promises for async I/O
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { newUuid } from '../uuid.js';
import type { StatInfo } from './types.js';

export const IGNORE_PATTERN = '.tmp_';

/**
 * Read file as UTF-8 string
 */
export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

/**
 * Write file atomically using write-to-temp + rename pattern
 * 
 * This ensures:
 * 1. Readers never see partially written files
 * 2. On crash, either old file or new file exists, never corrupted
 */
export async function writeAtomic(
  filePath: string, 
  content: string,
  options?: { encoding?: BufferEncoding; mode?: number }
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `${IGNORE_PATTERN}${newUuid()}`);
  
  try {
    // Write to temp file
    await fs.writeFile(tmpFile, content, {
      encoding: options?.encoding ?? 'utf-8',
      mode: options?.mode ?? 0o644,
    });
    
    // Ensure data is flushed to disk before rename
    const handle = await fs.open(tmpFile, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    // Atomic rename
    await fs.rename(tmpFile, filePath);

    // phase 369 §4 (review-2026-06-13): fsync parent dir after rename.
    // ext4 default / btrfs / ZFS 上 rename 可能仅入 page cache、未落 inode journal
    // → crash-after-rename-before-dir-journal 会丢 rename（文件内容 fsync'd 但 rename 没落）。
    // 打开 parent r-mode + fsync(fd) 保 rename 持久。Windows / 部分 FS 无法 r-open 目录、
    // 捕获 EISDIR/EACCES/EPERM/ENOTSUP/EINVAL 后静默（atomic 仍完成、durability 跨平台
    // 不保证但无回归）。
    try {
      const dirHandle = await fs.open(dir, 'r');
      try { await dirHandle.sync(); }
      finally { await dirHandle.close(); }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EISDIR' && code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EINVAL') {
        // silent: 跨 FS unsupported error 已枚举、其余少见、原 atomic 已完成、不抛
      }
      // silent: dir fsync unsupported on this FS / platform — atomic write 已完成
    }
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.unlink(tmpFile);
    } catch {
      // silent: rollback cleanup best-effort (tmpFile unlink failure leaves cleanup garbage); original error rethrown below preserves caller forensic
    }
    throw error;
  }
}

/**
 * Append content to file (creates if not exists)
 */
export async function appendFile(
  filePath: string, 
  content: string
): Promise<void> {
  await fs.appendFile(filePath, content, 'utf-8');
}

/**
 * Ensure directory exists (creates recursively)
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o755 });
}

/**
 * Delete a file
 */
export async function deleteFile(filePath: string): Promise<void> {
  await fs.unlink(filePath);
}

/**
 * Delete a directory and all contents
 */
export async function removeDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
}

/**
 * Move/rename a file or directory (atomic on same filesystem)
 */
export async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // phase 289 Step B: cross-filesystem fallback (mirror `mv` behavior)
    // atomicity is lost across fs boundaries, but business paths stay intact
    // phase 454 (review N3-M): fsync dst + size verify 让跨 fs 路径 crash-safe + 防 copyFile 截断
    const srcStat = await fs.stat(src);
    await fs.copyFile(src, dst);
    const fh = await fs.open(dst, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
    const dstStat = await fs.stat(dst);
    if (srcStat.size !== dstStat.size) {
      // size 不一致 → 不 unlink src（保 src 防数据丢失）、抛错让 caller 决策
      throw new Error(`moveFile EXDEV size mismatch: src=${src} (${srcStat.size}) dst=${dst} (${dstStat.size})`);
    }
    await fs.unlink(src);
  }
}

/**
 * Check if path exists
 */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Get file stats
 */
export async function stat(filePath: string): Promise<StatInfo> {
  const stats = await fs.stat(filePath);
  return {
    size: stats.size,
    mtime: stats.mtime,
    ctime: stats.ctime,
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
  };
}

/**
 * Check if path is a directory
 */
export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}
