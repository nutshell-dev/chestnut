/**
 * FileSystem types and interfaces (L1)
 *
 * Type definitions for all file I/O within chestnut.
 * Atomic writes, path guarding.
 */

import { formatErr } from '../node-utils/index.js';

type FSErrorCode = 'FS_NOT_FOUND';

export class FileNotFoundError extends Error {
  readonly code: FSErrorCode = 'FS_NOT_FOUND';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();

  constructor(path: string) {
    super(`File not found: "${path}"`);
    this.name = this.constructor.name;
    this.context = { path };
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      ...(this.cause !== undefined && { cause: formatErr(this.cause) }),
    };
  }
}

/**
 * Error thrown when a path fails the OS-level base-dir guard.
 *
 * This is intentionally an L1 primitive error: it carries no claw-space or
 * write-policy business semantics. Callers that need L4 semantics should catch
 * and wrap this error at the policy layer.
 */
export class PathGuardError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(message);
    this.name = 'PathGuardError';
    this.path = path;
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
 * Atomic write rename 后目录耐久性结果协议（phase 1752 冻结 / 1753 实施）。
 *
 * - `durable`：rename 后 parent-directory fsync 成功，提交完全持久。
 * - `committed_platform_limited`：rename 已成功（内容已提交可见），错误码属于
 *   已核实的平台目录 fsync 不支持集合；保留错误证据，调用方可观察但不应重试写入。
 * - `committed_durability_unknown`：rename 已成功，目录 fsync 发生其他错误；
 *   调用方必须把它作为已提交事实处理，不得盲目重写覆盖。
 *
 * rename 前（temp 写入、文件 fsync、rename 本身）失败仍抛原异常，不返回本类型。
 * async（Promise<AtomicWriteResult>）与 sync（AtomicWriteResult）字段完全对称。
 */
export type AtomicWriteResult =
  | { kind: 'durable' }
  | { kind: 'committed_platform_limited'; error: NodeJS.ErrnoException }
  | { kind: 'committed_durability_unknown'; error: NodeJS.ErrnoException };

/**
 * Options for FileSystem.list / FileSystem.listSync.
 * @member recursive - traverse subdirectories
 * @member includeDirs - include directory entries in result
 * @member pattern - regular expression pattern for filename filter
 */
interface ListOptions {
  recursive?: boolean;
  includeDirs?: boolean;
  pattern?: string;
}

/**
 * FileSystem interface - Abstract file operations
 * 
 * Implementation notes:
 * - Most methods are async (Promise-based); synchronous variants available for hot paths
 * - Paths are validated to be within configured baseDir (implementation responsibility)
 * - Atomic writes ensure no partial files on crash
 */
export interface FileSystem {
  // ========================================================================
  // Basic File Operations
  // ========================================================================
  
  /**
   * Read file content as string
   * @param path - Relative path within configured baseDir
   * @returns File content
   * @throws FileNotFoundError if file doesn't exist
   */
  read(path: string): Promise<string>;

  /**
   * Write file atomically (write-to-temp + rename)
   * @param path - Relative path within configured baseDir
   * @param content - Content to write
   * @returns AtomicWriteResult — rename 后目录耐久性三态协议（phase 1753）
   * @throws PathGuardError if path is outside configured baseDir
   * @throws 原异常 if rename 前失败（temp 写入 / 文件 fsync / rename 本身）
   */
  writeAtomic(path: string, content: string): Promise<AtomicWriteResult>;

  /**
   * Write file atomically, requiring the parent directory to already exist.
   *
   * Phase 1201 Step E: 与 `writeAtomic` 相同的 temp+rename+fsync 协议，但
   * 不创建 parent 或任何 ancestor：parent 不存在 → FileNotFoundError。
   * 用于 published active progress commit——terminal rename 若先胜出，
   * temp 创建即 ENOENT，不会 ghost-recreate 已归档的 active 目录。
   *
   * @param path - Relative path within configured baseDir
   * @param content - Content to write
   * @returns AtomicWriteResult — rename 后目录耐久性三态协议（phase 1753）
   * @throws FileNotFoundError if the parent directory does not exist
   * @throws PathGuardError if path is outside configured baseDir
   * @throws 原异常 if rename 前失败
   */
  writeAtomicExisting(path: string, content: string): Promise<AtomicWriteResult>;
  
  /**
   * Append content to file (creates if not exists)
   * @param path - Relative path within configured baseDir
   * @param content - Content to append
   */
  append(path: string, content: string): Promise<void>;
  
  /**
   * Delete a file
   * @param path - Relative path within configured baseDir
   * @throws FileNotFoundError if file doesn't exist
   */
  delete(path: string): Promise<void>;

  /**
   * Move/rename a file atomically.
   * For directories, use moveDir().
   * @param fromPath - Source path (relative within configured baseDir)
   * @param toPath - Destination path (relative within configured baseDir)
   */
  move(fromPath: string, toPath: string): Promise<void>;

  // ========================================================================
  // Directory Operations
  // ========================================================================
  
  /**
   * Ensure directory exists (creates recursively if needed)
   * @param path - Relative path within configured baseDir
   */
  ensureDir(path: string): Promise<void>;
  
  /**
   * Remove directory and all contents
   * @param path - Relative path within configured baseDir
   */
  removeDir(path: string): Promise<void>;

  /**
   * Move/rename a directory atomically (same filesystem);
   * cross-filesystem EXDEV fallback: recursive copy + size verify + unlink src.
   * @param fromPath - Source directory path (relative within configured baseDir)
   * @param toPath - Destination path (relative within configured baseDir)
   */
  moveDir(fromPath: string, toPath: string): Promise<void>;
  
  /**
   * List directory contents
   * @param path - Relative path within configured baseDir
   * @param options - Listing options
   * @returns Array of file entries
   */
  list(path: string, options?: ListOptions): Promise<FileEntry[]>;
  
  // ========================================================================
  // Path Queries
  // ========================================================================
  
  /**
   * Resolve symlinks to canonical absolute path
   * @param path - Relative path within configured baseDir
   * @returns Resolved absolute path
   */
  realpath(path: string): Promise<string>;

  /**
   * Check if path exists
   * @param path - Relative path within configured baseDir
   */
  exists(path: string): Promise<boolean>;
  
  /**
   * Check if path is a directory
   * @param path - Relative path within configured baseDir
   */
  isDirectory(path: string): Promise<boolean>;
  
  /**
   * Get file stats
   * @param path - Relative path within configured baseDir
   */
  stat(path: string): Promise<StatInfo>;

  /**
   * Update file access and modification times.
   * @param path - Relative path within configured baseDir
   * @param atime - New access time
   * @param mtime - New modification time
   */
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;

  // ========================================================================
  // Synchronous Operations
  // ========================================================================

  /**
   * Write file atomically (sync version of writeAtomic).
   * Uses write-to-temp + fsync + rename pattern.
   * @param path - Relative path within configured baseDir
   * @param content - Content to write
   * @returns AtomicWriteResult — 与 async writeAtomic 字段完全对称（phase 1753）
   */
  writeAtomicSync(path: string, content: string): AtomicWriteResult;

  /**
   * Create file exclusively and write content. Throws EEXIST if file already exists.
   * For lock-file semantics (PID file exclusive create).
   * Caller must ensure parent directory exists.
   * @param path - Relative path within configured baseDir
   * @param content - Content to write
   * @throws Error with code EEXIST if file already exists
   */
  writeExclusiveSync(path: string, content: string): void;

  /**
   * Atomic exclusive write (O_EXCL) — async variant of writeExclusiveSync.
   * Creates the file if it does not exist, throws EEXIST if it does.
   * Parent directory auto-created (mkdir recursive). Includes fsync for durability.
   * Use for caller-driven "only create if absent" semantics (e.g. template
   * scaffolding) — single syscall eliminates exists+write TOCTOU windows.
   * @param path - Relative path within configured baseDir
   * @param content - Content to write
   * @throws Error with code EEXIST if file already exists
   */
  writeExclusive(path: string, content: string): Promise<void>;

  /**
   * Read file content synchronously.
   * @param path - Relative path within configured baseDir
   * @throws FileNotFoundError if file doesn't exist
   */
  readSync(path: string): string;

  /**
   * Read a byte range from a file synchronously (returns raw Buffer).
   * Used by incremental-read consumers (e.g. stream reader) that need
   * byte-safe offsets free of UTF-8/UTF-16 index mismatch.
   * @param path - Relative path within configured baseDir
   * @param start - Byte offset (inclusive)
   * @param end - Byte offset (exclusive); if file shorter, returns available bytes
   * @returns Buffer containing bytes in [start, end); length ≤ end - start
   * @throws FileNotFoundError if file doesn't exist
   */
  readBytesSync(path: string, start: number, end: number): Buffer;

  /**
   * Append content to file synchronously.
   * For high-frequency writes where async overhead matters (audit log, stream).
   * @param path - Relative path within configured baseDir
   * @param content - Content to append
   */
  appendSync(path: string, content: string): void;

  /**
   * Get file stats synchronously.
   * @param path - Relative path within configured baseDir
   * @throws FileNotFoundError if file doesn't exist
   */
  statSync(path: string): StatInfo;

  /**
   * Move/rename a file synchronously.
   * For directories, use moveDirSync().
   * @param fromPath - Source path (relative within configured baseDir)
   * @param toPath - Destination path (relative within configured baseDir)
   */
  moveSync(fromPath: string, toPath: string): void;

  /**
   * Check if path exists synchronously.
   * @param path - Relative path within configured baseDir
   */
  existsSync(path: string): boolean;

  /**
   * Ensure directory exists synchronously (creates recursively if needed).
   * @param path - Relative path within configured baseDir
   */
  ensureDirSync(path: string): void;

  /**
   * List directory contents synchronously.
   * @param path - Relative path within configured baseDir
   * @param options - Listing options
   */
  listSync(path: string, options?: ListOptions): FileEntry[];

  /**
   * Remove directory and all contents (sync).
   * @throws if path is not a directory or other I/O error
   */
  removeDirSync(path: string): void;

  /**
   * Move/rename a directory atomically (same filesystem), synchronously;
   * cross-filesystem EXDEV fallback: recursive copy + size verify + unlink src.
   * @param fromPath - Source directory path (relative within configured baseDir)
   * @param toPath - Destination path (relative within configured baseDir)
   */
  moveDirSync(fromPath: string, toPath: string): void;

  /**
   * Resolve symlinks to canonical absolute path (sync).
   * @throws if path does not exist
   */
  realpathSync(path: string): string;

  /**
   * Check if path is a directory (sync).
   * Returns false if path does not exist.
   */
  isDirectorySync(path: string): boolean;

  /**
   * Update file access and modification times (sync).
   * @param path - Relative path within configured baseDir
   * @param atime - New access time
   * @param mtime - New modification time
   */
  utimesSync(path: string, atime: Date, mtime: Date): void;

  /**
   * Delete a file synchronously.
   * @param path - Relative path within configured baseDir
   * @throws FileNotFoundError if file doesn't exist
   */
  deleteSync(path: string): void;

  /**
   * Synchronize file data to disk (fsync).
   * Ensures durability for audit/log paths.
   * @param path - Relative path within configured baseDir
   */
  syncSync(path: string): void;

  // ========================================================================
  // Path Resolution
  // ========================================================================

  /**
   * Resolve a relative path to absolute path within this FileSystem's baseDir.
   * Validates path is within allowed bounds (traversal protection, symlink check).
   * @param relativePath - Relative path within baseDir
   * @returns Absolute path
   * @throws PathGuardError if path escapes base directory
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
