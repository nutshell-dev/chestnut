/**
 * FileSystem types and interfaces (L1)
 *
 * Type definitions for all file I/O within clawforum.
 * Atomic writes, path guarding.
 */

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtime: Date;
}

/**
 * FileSystem interface - Abstract file operations
 * 
 * Implementation notes:
 * - Most methods are async (Promise-based); synchronous variants available for hot paths
 * - Paths are validated to be within claw space (implementation responsibility)
 * - Atomic writes ensure no partial files on crash
 */
export interface IFileSystem {
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
  stat(path: string): Promise<{
    size: number;
    mtime: Date;
    ctime: Date;
    isFile: boolean;
    isDirectory: boolean;
  }>;

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
  statSync(path: string): {
    size: number;
    mtime: Date;
    ctime: Date;
    isFile: boolean;
    isDirectory: boolean;
  };

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
 * FileSystem factory options
 */
export interface FileSystemOptions {
  /** Base directory for all operations */
  baseDir: string;
  
  /** Enable permission checks (default: true) */
  enforcePermissions?: boolean;
  
  /** Additional allowed paths outside baseDir (e.g., skills directory) */
  allowedPaths?: string[];
}
