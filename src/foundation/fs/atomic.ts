/**
 * Atomic file operations
 * 
 * - writeAtomic: write to temp file + rename (atomic on POSIX)
 * - All operations use fs/promises for async I/O
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
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
  const tmpFile = path.join(dir, `${IGNORE_PATTERN}${randomUUID()}`);
  
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
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors
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
  await fs.rename(src, dst);
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
