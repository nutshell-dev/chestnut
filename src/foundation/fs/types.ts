/**
 * FileSystem types and interfaces (L1)
 *
 * Type definitions for all file I/O within clawforum.
 * Atomic writes, path guarding.
 */

import { ClawError, type ErrorCode } from '../errors.js';

export class FileNotFoundError extends ClawError {
  readonly code: ErrorCode = 'FS_NOT_FOUND';

  constructor(path: string) {
    super(`File not found: "${path}"`, { path });
  }
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtime: Date;
}

/**
 * File stat info (named export for explicit coupling + compiler checking)
 */
export interface StatInfo {
  size: number;
  mtime: Date;
  ctime: Date;
  isDirectory: boolean;
  isFile: boolean;
}

/**
 * FileSystem interface - Abstract file operations
 * 
 * Implementation notes:
 * - Most methods are async (Promise-based); synchronous variants available for hot paths
 * - Paths are validated to be within claw space (implementation responsibility)
 * - Atomic writes ensure no partial files on crash
 */
export interface FileSystem {
  // ========================================================================
  // Basic File Operations
  // ========================================================================
  
  /**
   * Read file content as string
   * @param path - Relative path within claw space
   * @returns File content
   * @throws FileNotFoundError if file doesn't exist
   */
  read(path: string): Promise<string>;

  /**
   * Write file atomically (write-to-temp + rename)
   * @param path - Relative path within claw space
   * @param content - Content to write
   * @throws PathNotInClawSpaceError if path is outside claw space
   */
  writeAtomic(path: string, content: string): Promise<void>;
  
  /**
   * Append content to file (creates if not exists)
   * @param path - Relative path within claw space
   * @param content - Content to append
   */
  append(path: string, content: string): Promise<void>;
  
  /**
   * Delete a file
   * @param path - Relative path within claw space
   * @throws FileNotFoundError if file doesn't exist
   */
  delete(path: string): Promise<void>;

  /**
   * Move/rename a file atomically
   * @param fromPath - Source path (relative within claw space)
   * @param toPath - Destination path (relative within claw space)
   */
  move(fromPath: string, toPath: string): Promise<void>;

  // ========================================================================
  // Directory Operations
  // ========================================================================
  
  /**
   * Ensure directory exists (creates recursively if needed)
   * @param path - Relative path within claw space
   */
  ensureDir(path: string): Promise<void>;
  
  /**
   * Remove directory and all contents
   * @param path - Relative path within claw space
   */
  removeDir(path: string): Promise<void>;
  
  /**
   * List directory contents
   * @param path - Relative path within claw space
   * @param options - Listing options
   * @returns Array of file entries
   */
  list(path: string, options?: {
    recursive?: boolean;
    includeDirs?: boolean;
    pattern?: string;  // glob pattern
  }): Promise<FileEntry[]>;
  
  // ========================================================================
  // Path Queries
  // ========================================================================
  
  /**
   * Resolve symlinks to canonical absolute path
   * @param path - Relative path within claw space
   * @returns Resolved absolute path
   */
  realpath(path: string): Promise<string>;

  /**
   * Check if path exists
   * @param path - Relative path within claw space
   */
  exists(path: string): Promise<boolean>;
  
  /**
   * Check if path is a directory
   * @param path - Relative path within claw space
   */
  isDirectory(path: string): Promise<boolean>;
  
  /**
   * Get file stats
   * @param path - Relative path within claw space
   */
  stat(path: string): Promise<StatInfo>;

  // ========================================================================
  // Synchronous Operations
  // ========================================================================

  /**
   * Write file atomically (sync version of writeAtomic).
   * Uses write-to-temp + fsync + rename pattern.
   * @param path - Relative path within claw space
   * @param content - Content to write
   */
  writeAtomicSync(path: string, content: string): void;

  /**
   * Create file exclusively and write content. Throws EEXIST if file already exists.
   * For lock-file semantics (PID file exclusive create).
   * Caller must ensure parent directory exists.
   * @param path - Relative path within claw space
   * @param content - Content to write
   * @throws Error with code EEXIST if file already exists
   */
  writeExclusiveSync(path: string, content: string): void;

  /**
   * Read file content synchronously.
   * @param path - Relative path within claw space
   * @throws FileNotFoundError if file doesn't exist
   */
  readSync(path: string): string;

  /**
   * Read a byte range from a file synchronously (returns raw Buffer).
   * Used by incremental-read consumers (e.g. stream reader) that need
   * byte-safe offsets free of UTF-8/UTF-16 index mismatch.
   * @param path - Relative path within claw space
   * @param start - Byte offset (inclusive)
   * @param end - Byte offset (exclusive); if file shorter, returns available bytes
   * @returns Buffer containing bytes in [start, end); length ≤ end - start
   * @throws FileNotFoundError if file doesn't exist
   */
  readBytesSync(path: string, start: number, end: number): Buffer;

  /**
   * Append content to file synchronously.
   * For high-frequency writes where async overhead matters (audit log, stream).
   * @param path - Relative path within claw space
   * @param content - Content to append
   */
  appendSync(path: string, content: string): void;

  /**
   * Get file stats synchronously.
   * @param path - Relative path within claw space
   * @throws FileNotFoundError if file doesn't exist
   */
  statSync(path: string): StatInfo;

  /**
   * Move/rename a file synchronously.
   * @param fromPath - Source path (relative within claw space)
   * @param toPath - Destination path (relative within claw space)
   */
  moveSync(fromPath: string, toPath: string): void;

  /**
   * Check if path exists synchronously.
   * @param path - Relative path within claw space
   */
  existsSync(path: string): boolean;

  /**
   * Ensure directory exists synchronously (creates recursively if needed).
   * @param path - Relative path within claw space
   */
  ensureDirSync(path: string): void;

  /**
   * List directory contents synchronously.
   * @param path - Relative path within claw space
   * @param options - Listing options
   */
  listSync(path: string, options?: {
    recursive?: boolean;
    includeDirs?: boolean;
    pattern?: string;
  }): FileEntry[];

  /**
   * Delete a file synchronously.
   * @param path - Relative path within claw space
   * @throws FileNotFoundError if file doesn't exist
   */
  deleteSync(path: string): void;

  // ========================================================================
  // Path Resolution
  // ========================================================================

  /**
   * Resolve a relative path to absolute path within this FileSystem's baseDir.
   * Validates path is within allowed bounds (traversal protection, symlink check).
   * @param relativePath - Relative path within baseDir
   * @returns Absolute path
   * @throws PermissionError if path escapes base directory
   */
  resolve(relativePath: string): string;
}

/**
 * 判 err 是否表示「文件不存在」语义。
 *
 * 兼容两路径：
 * 1. FileSystem 抽象层抛 FileNotFoundError (code='FS_NOT_FOUND')
 * 2. Node 原生 fs.* 抛 NodeJS.ErrnoException (code='ENOENT')
 *
 * phase 1154 derive：phase 1010 narrow 写 'ENOENT' 单码 / FileSystem
 * 抛 FS_NOT_FOUND / 真 production 100% miss → 4.88M 行垃圾 audit。
 *
 * 不归属：ENOTDIR / EACCES / 其他 fs 错误不在此判定范围。
 */
export function isFileNotFound(err: unknown): boolean {
  if (err instanceof FileNotFoundError) return true;
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  return false;
}

/**
 * FileSystem factory options
 */
export interface FileSystemOptions {
  /** Base directory for all operations */
  baseDir: string;
}
