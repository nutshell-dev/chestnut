/**
 * @module L1.FileSystem
 * FileSystem module (L1)
 *
 * chestnut 进程内代码的所有文件 I/O 的唯一入口。
 * 原子写、路径守护（OS 级 base-dir traversal + symlink）。
 * 零业务概念 — claw-space boundary 由 L4 caller 自治。
 */

// Types and interfaces
export type {
  FileEntry,
  FileSystem,
  FileSystemOptions,
  StatInfo,
} from './types.js';
export { FileNotFoundError, isFileNotFound } from './types.js';

// Implementation classes
export { NodeFileSystem } from './node-fs.js';

// Atomic file operations
export {
  readFile,
  writeAtomic,
  appendFile,
  ensureDir,
  deleteFile,
  removeDir,
  moveFile,
  exists,
  stat,
  isDirectory,
  IGNORE_PATTERN,
} from './atomic.js';
