/**
 * NodeFileSystem - FileSystem implementation using Node.js fs/promises
 *
 * Atomic operations + path guarding (OS-level base-dir traversal + symlink)
 * Zero business policy — claw-space boundary is caller-owned (L4).
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs, realpathSync } from 'fs';
import * as fsSync from 'fs';
import type {
  FileSystem,
  FileSystemOptions,
  FileEntry,
  StatInfo,
} from './types.js';
import {
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
import { FileNotFoundError } from './types.js';
import { PermissionError } from '../errors.js';

async function wrapENOENT<T>(
  relativePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FileNotFoundError(relativePath);
    }
    throw error;
  }
}

function wrapENOENTSync<T>(
  relativePath: string,
  fn: () => T,
): T {
  try {
    return fn();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FileNotFoundError(relativePath);
    }
    throw error;
  }
}

/**
 * Node.js FileSystem implementation
 */
export class NodeFileSystem implements FileSystem {
  constructor(
    private readonly options: FileSystemOptions,
  ) {}
  
  // ========================================================================
  // Path utilities
  // ========================================================================
  
  /**
   * Resolve relative path to absolute, with base-dir traversal guard
   */
  private resolveAndCheck(relativePath: string): string {
    // Resolve symlinks to prevent traversal via symlinks (OS-level guard)
    const realBase = (() => {
      try { return realpathSync(this.options.baseDir); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.options.baseDir;
        throw err; // EACCES, EIO, etc. — 不可恢复，应 propagate
      }
    })();

    // P0 hardening (phase 611): absolute path 显式 reject if outside baseDir
    // path.normalize 不 strip 前缀 '/' / 依赖后续 realpath check 在 read+missing 路径有 fall-through gap
    if (path.isAbsolute(relativePath)) {
      const resolved = path.resolve(this.options.baseDir, relativePath);
      const resolvedBase = path.resolve(this.options.baseDir);
      const basePrefix = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
      const withinBase =
        resolved === resolvedBase ||
        resolved.startsWith(basePrefix);
      if (!withinBase) {
        throw new PermissionError(
          `Path "${relativePath}" is absolute, must be relative to baseDir`,
          { path: relativePath }
        );
      }
      // Absolute path within baseDir: convert to relative for consistent resolution
      relativePath = path.relative(this.options.baseDir, resolved);
      if (relativePath === '') relativePath = '.';
    }

    // Normalize path to prevent directory traversal
    const normalized = path.normalize(relativePath);
    
    if (normalized.startsWith('..')) {
      throw new PermissionError(
        `Path "${relativePath}" attempts to escape base directory`,
        { path: relativePath }
      );
    }
    
    const absolute = path.resolve(this.options.baseDir, normalized);

    let realTarget: string | null = null;
    try {
      realTarget = realpathSync(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet; still check parent directory for symlink traversal
        try {
          realTarget = realpathSync(path.dirname(absolute));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // Parent doesn't exist (write: will be created by ensureDir; read: will fail naturally) — accept
          } else {
            throw err; // EACCES, EIO — propagate
          }
        }
      }
    }

    if (realTarget !== null) {
      const basePrefix = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
      const withinBase =
        realTarget === realBase ||
        realTarget.startsWith(basePrefix);
      if (!withinBase) {
        throw new PermissionError(
          `Symlink traversal detected: "${relativePath}" resolves outside base directory`,
          { path: relativePath }
        );
      }
    }

    return absolute;
  }
  
  // ========================================================================
  // Basic File Operations
  // ========================================================================
  
  async read(relativePath: string): Promise<string> {
    const absolute = this.resolveAndCheck(relativePath);
    return wrapENOENT(relativePath, () => readFile(absolute));
  }

  async writeAtomic(relativePath: string, content: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath);
    
    // Ensure parent directory exists
    const dir = path.dirname(absolute);
    await ensureDir(dir);
    
    await writeAtomic(absolute, content);
  }
  
  async append(relativePath: string, content: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath);
    
    // Ensure parent directory exists
    const dir = path.dirname(absolute);
    await ensureDir(dir);
    
    await appendFile(absolute, content);
  }
  
  async delete(relativePath: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath);
    return wrapENOENT(relativePath, () => deleteFile(absolute));
  }
  
  // ========================================================================
  // Directory Operations
  // ========================================================================
  
  async ensureDir(relativePath: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath);
    await ensureDir(absolute);
  }
  
  async removeDir(relativePath: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath);
    await removeDir(absolute);
  }
  
  async list(
    relativePath: string,
    options?: {
      recursive?: boolean;
      includeDirs?: boolean;
      pattern?: string;
    }
  ): Promise<FileEntry[]> {
    const absolute = this.resolveAndCheck(relativePath);
    
    if (!(await isDirectory(absolute))) {
      throw new FileNotFoundError(relativePath);
    }
    
    const entries: FileEntry[] = [];
    const fsBaseDir = this.options.baseDir; // fs 根目录
    
    async function scan(dir: string, listedDir: string): Promise<void> {
      // Use simple readdir for listing
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      const items = dirents.filter(item => {
        if (!options?.pattern) return true;
        return new RegExp(options.pattern).test(item.name);
      });
      
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        // entry.path 应该相对于 fs 根目录，而非被列举目录
        const relativeToFsRoot = path.relative(fsBaseDir, fullPath);
        
        if (item.isDirectory()) {
          if (options?.includeDirs) {
            const stats = await stat(fullPath);
            entries.push({
              name: item.name,
              path: relativeToFsRoot,
              isDirectory: true,
              isFile: false,
              size: 0,
              mtime: stats.mtime,
            });
          }
          
          if (options?.recursive) {
            await scan(fullPath, listedDir);
          }
        } else if (item.isFile()) {
          const stats = await stat(fullPath);
          entries.push({
            name: item.name,
            path: relativeToFsRoot,
            isDirectory: false,
            isFile: true,
            size: stats.size,
            mtime: stats.mtime,
          });
        }
      }
    }
    
    await scan(absolute, absolute);
    
    return entries;
  }
  
  // ========================================================================
  // Path Queries
  // ========================================================================
  
  async realpath(relativePath: string): Promise<string> {
    const absolute = this.resolveAndCheck(relativePath);
    return await fs.realpath(absolute);
  }

  async exists(relativePath: string): Promise<boolean> {
    let absolute: string;
    try {
      absolute = this.resolveAndCheck(relativePath);
    } catch (err) {
      if (err instanceof PermissionError) {
        throw err;  // P1.5 hardening: 安全 signal 不静默 / D2+D11 align
      }
      return false;  // 其他（normalize 错等）视为不存在
    }
    return await exists(absolute);
  }
  
  async isDirectory(relativePath: string): Promise<boolean> {
    const absolute = this.resolveAndCheck(relativePath);
    return await isDirectory(absolute);
  }
  
  async stat(relativePath: string): Promise<StatInfo> {
    const absolute = this.resolveAndCheck(relativePath);
    return wrapENOENT(relativePath, () => stat(absolute));
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const fromAbsolute = this.resolveAndCheck(fromPath);
    const toAbsolute = this.resolveAndCheck(toPath);

    // Ensure destination directory exists
    await ensureDir(path.dirname(toAbsolute));

    return wrapENOENT(fromPath, () => moveFile(fromAbsolute, toAbsolute));
  }

  resolve(relativePath: string): string {
    return this.resolveAndCheck(relativePath);
  }

  // ========================================================================
  // Synchronous Operations
  // ========================================================================

  writeAtomicSync(relativePath: string, content: string): void {
    const absolute = this.resolveAndCheck(relativePath);
    const dir = path.dirname(absolute);
    fsSync.mkdirSync(dir, { recursive: true });
    const tmpFile = path.join(dir, `${IGNORE_PATTERN}${randomUUID()}`);

    try {
      fsSync.writeFileSync(tmpFile, content, { encoding: 'utf-8', mode: 0o644 });
      // fsync for durability
      const fd = fsSync.openSync(tmpFile, 'r+');
      try { fsSync.fsyncSync(fd); } finally { fsSync.closeSync(fd); }
      fsSync.renameSync(tmpFile, absolute);
    } catch (error) {
      try { fsSync.unlinkSync(tmpFile); } catch { /* silent: tmpFile cleanup best-effort post-rename / ENOENT race acceptable / phase TBD convert to canonical */ }
      throw error;
    }
  }

  writeExclusiveSync(relativePath: string, content: string): void {
    const absolute = this.resolveAndCheck(relativePath);
    const dir = path.dirname(absolute);
    fsSync.mkdirSync(dir, { recursive: true }); // phase 948: mirror writeAtomicSync 对称 invariant（防 latent ENOENT 跨 caller）
    // 'wx' = write + exclusive, throws EEXIST if file exists
    const fd = fsSync.openSync(absolute, 'wx');
    try {
      if (content) {
        fsSync.writeFileSync(fd, content, { encoding: 'utf-8' });
      }
      // fsync for durability (lock file crash-safe / align with writeAtomicSync line 295 / phase 610)
      fsSync.fsyncSync(fd);
    } finally {
      fsSync.closeSync(fd);
    }
  }

  readSync(relativePath: string): string {
    const absolute = this.resolveAndCheck(relativePath);
    return wrapENOENTSync(relativePath, () => fsSync.readFileSync(absolute, 'utf-8'));
  }

  readBytesSync(relativePath: string, start: number, end: number): Buffer {
    const absolute = this.resolveAndCheck(relativePath);
    return wrapENOENTSync(relativePath, () => {
      const fd = fsSync.openSync(absolute, 'r');
      try {
        const length = end - start;
        if (length <= 0) return Buffer.alloc(0);
        const buf = Buffer.alloc(length);
        const bytesRead = fsSync.readSync(fd, buf, 0, length, start);
        return bytesRead === length ? buf : buf.subarray(0, bytesRead);
      } finally {
        fsSync.closeSync(fd);
      }
    });
  }

  appendSync(relativePath: string, content: string): void {
    const absolute = this.resolveAndCheck(relativePath);
    const dir = path.dirname(absolute);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.appendFileSync(absolute, content, 'utf-8');
  }

  moveSync(fromPath: string, toPath: string): void {
    return wrapENOENTSync(fromPath, () => {
      const fromAbsolute = this.resolveAndCheck(fromPath);
      const toAbsolute = this.resolveAndCheck(toPath);
      fsSync.mkdirSync(path.dirname(toAbsolute), { recursive: true });
      fsSync.renameSync(fromAbsolute, toAbsolute);
    });
  }

  existsSync(relativePath: string): boolean {
    const absolute = this.resolveAndCheck(relativePath);
    return fsSync.existsSync(absolute);
  }

  ensureDirSync(relativePath: string): void {
    const absolute = this.resolveAndCheck(relativePath);
    fsSync.mkdirSync(absolute, { recursive: true });
  }

  listSync(relativePath: string, options?: {
    recursive?: boolean;
    includeDirs?: boolean;
    pattern?: string;
  }): FileEntry[] {
    const absolute = this.resolveAndCheck(relativePath);
    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw err;
    }
    if (!stat.isDirectory()) {
      throw new FileNotFoundError(relativePath);
    }

    const entries: FileEntry[] = [];
    const fsBaseDir = this.options.baseDir;

    function scan(dir: string): void {
      const dirents = fsSync.readdirSync(dir, { withFileTypes: true });
      const items = dirents.filter(item => {
        if (!options?.pattern) return true;
        return new RegExp(options.pattern).test(item.name);
      });

      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        // path relative to fs root (align with list async line 193 / phase 610 P1.1)
        const relativeToFsRoot = path.relative(fsBaseDir, fullPath);

        if (item.isDirectory()) {
          if (options?.includeDirs) {
            const stats = fsSync.statSync(fullPath);
            entries.push({
              name: item.name,
              path: relativeToFsRoot,
              isDirectory: true,
              isFile: false,
              size: 0,
              mtime: stats.mtime,
            });
          }
          if (options?.recursive) {
            scan(fullPath);
          }
        } else if (item.isFile()) {
          const stats = fsSync.statSync(fullPath);
          entries.push({
            name: item.name,
            path: relativeToFsRoot,
            isDirectory: false,
            isFile: true,
            size: stats.size,
            mtime: stats.mtime,
          });
        }
      }
    }

    scan(absolute);
    return entries;
  }

  statSync(relativePath: string): {
    size: number;
    mtime: Date;
    ctime: Date;
    isFile: boolean;
    isDirectory: boolean;
  } {
    const absolute = this.resolveAndCheck(relativePath);
    return wrapENOENTSync(relativePath, () => {
      const s = fsSync.statSync(absolute);
      return {
        size: s.size,
        mtime: s.mtime,
        ctime: s.ctime,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
      };
    });
  }

  deleteSync(relativePath: string): void {
    const absolute = this.resolveAndCheck(relativePath);
    return wrapENOENTSync(relativePath, () => fsSync.unlinkSync(absolute));
  }

  removeDirSync(relativePath: string): void {
    const absolute = this.resolveAndCheck(relativePath);
    fsSync.rmSync(absolute, { recursive: true, force: true });
  }

  realpathSync(relativePath: string): string {
    const absolute = this.resolveAndCheck(relativePath);
    return fsSync.realpathSync(absolute);
  }

  isDirectorySync(relativePath: string): boolean {
    try {
      const absolute = this.resolveAndCheck(relativePath);
      return fsSync.statSync(absolute).isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  syncSync(relativePath: string): void {
    const absolute = this.resolveAndCheck(relativePath);
    const fd = fsSync.openSync(absolute, 'r+');
    try {
      fsSync.fsyncSync(fd);
    } finally {
      fsSync.closeSync(fd);
    }
  }
}
