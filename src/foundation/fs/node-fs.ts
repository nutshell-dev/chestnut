/**
 * NodeFileSystem - FileSystem implementation using Node.js fs/promises
 *
 * Atomic operations + path guarding + permission domains
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs, realpathSync } from 'fs';
import * as fsSync from 'fs';
import type {
  FileSystem,
  FileSystemOptions,
  FileEntry,
} from './index.js';
import type { PermissionChecker } from './permissions.js';
import {
  createPermissionChecker,
  type PermissionOptions,
} from './permissions.js';
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
  cleanupOrphanedTemp,
} from './atomic.js';
import {
  FileNotFoundError,
  PermissionError,
} from '../../types/errors.js';

/**
 * Node.js FileSystem implementation
 */
export class NodeFileSystem implements FileSystem {
  private readonly permissionChecker: PermissionChecker;
  private readonly enforcePermissions: boolean;
  
  constructor(private readonly options: FileSystemOptions) {
    this.enforcePermissions = options.enforcePermissions ?? true;
    
    const permOptions: PermissionOptions = {
      clawDir: options.baseDir,
      strict: this.enforcePermissions,
    };
    
    this.permissionChecker = createPermissionChecker(permOptions);
  }
  
  // ========================================================================
  // Path utilities
  // ========================================================================
  
  /**
   * Resolve relative path to absolute, with permission check
   */
  private resolveAndCheck(
    relativePath: string, 
    operation: 'read' | 'write'
  ): string {
    // Normalize path to prevent directory traversal
    const normalized = path.normalize(relativePath);
    
    if (normalized.startsWith('..')) {
      throw new PermissionError(
        `Path "${relativePath}" attempts to escape base directory`,
        { path: relativePath }
      );
    }
    
    const absolute = path.resolve(this.options.baseDir, normalized);

    // Resolve symlinks to prevent traversal via symlinks
    if (this.enforcePermissions) {
      const realBase = (() => {
        try { return realpathSync(this.options.baseDir); } catch { return this.options.baseDir; }
      })();

      let realTarget: string | null = null;
      try {
        realTarget = realpathSync(absolute);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' && operation === 'write') {
          // File doesn't exist yet; check parent directory instead
          try {
            realTarget = realpathSync(path.dirname(absolute));
          } catch {
            // Parent also doesn't exist (will be created by ensureDir) — accept
          }
        }
        // For read ENOENT: leave realTarget null, let caller handle missing file
      }

      if (realTarget !== null) {
        const withinBase =
          realTarget === realBase ||
          realTarget.startsWith(realBase + path.sep);
        if (!withinBase) {
          throw new PermissionError(
            `Symlink traversal detected: "${relativePath}" resolves outside base directory`,
            { path: relativePath }
          );
        }
      }

      if (operation === 'read') {
        this.permissionChecker.checkRead(absolute);
      } else {
        this.permissionChecker.checkWrite(absolute);
      }
    }

    return absolute;
  }
  
  // ========================================================================
  // Basic File Operations
  // ========================================================================
  
  async read(relativePath: string): Promise<string> {
    const absolute = this.resolveAndCheck(relativePath, 'read');

    try {
      return await readFile(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw error;
    }
  }

  async writeAtomic(relativePath: string, content: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    
    // Ensure parent directory exists
    const dir = path.dirname(absolute);
    await ensureDir(dir);
    
    await writeAtomic(absolute, content);
  }
  
  async append(relativePath: string, content: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    
    // Ensure parent directory exists
    const dir = path.dirname(absolute);
    await ensureDir(dir);
    
    await appendFile(absolute, content);
  }
  
  async delete(relativePath: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    
    try {
      await deleteFile(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw error;
    }
  }
  
  // ========================================================================
  // Directory Operations
  // ========================================================================
  
  async ensureDir(relativePath: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    await ensureDir(absolute);
  }
  
  async removeDir(relativePath: string): Promise<void> {
    const absolute = this.resolveAndCheck(relativePath, 'write');
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
    const absolute = this.resolveAndCheck(relativePath, 'read');
    
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
  
  async exists(relativePath: string): Promise<boolean> {
    try {
      const absolute = this.resolveAndCheck(relativePath, 'read');
      return await exists(absolute);
    } catch {
      return false;
    }
  }
  
  async isDirectory(relativePath: string): Promise<boolean> {
    const absolute = this.resolveAndCheck(relativePath, 'read');
    return await isDirectory(absolute);
  }
  
  async stat(relativePath: string): Promise<{
    size: number;
    mtime: Date;
    ctime: Date;
    isFile: boolean;
    isDirectory: boolean;
  }> {
    const absolute = this.resolveAndCheck(relativePath, 'read');
    
    try {
      return await stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw error;
    }
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const fromAbsolute = this.resolveAndCheck(fromPath, 'write');
    const toAbsolute = this.resolveAndCheck(toPath, 'write');

    // Ensure destination directory exists
    await ensureDir(path.dirname(toAbsolute));

    await moveFile(fromAbsolute, toAbsolute);
  }

  resolve(relativePath: string): string {
    return this.resolveAndCheck(relativePath, 'read');
  }

  // ========================================================================
  // Synchronous Operations
  // ========================================================================

  writeAtomicSync(relativePath: string, content: string): void {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    const dir = path.dirname(absolute);
    fsSync.mkdirSync(dir, { recursive: true });
    const tmpFile = path.join(dir, `.tmp_${randomUUID()}`);

    try {
      fsSync.writeFileSync(tmpFile, content, { encoding: 'utf-8', mode: 0o644 });
      // fsync for durability
      const fd = fsSync.openSync(tmpFile, 'r+');
      try { fsSync.fsyncSync(fd); } finally { fsSync.closeSync(fd); }
      fsSync.renameSync(tmpFile, absolute);
    } catch (error) {
      try { fsSync.unlinkSync(tmpFile); } catch { /* ignore */ }
      throw error;
    }
  }

  writeExclusiveSync(relativePath: string, content: string): void {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    // 'wx' = write + exclusive, throws EEXIST if file exists
    const fd = fsSync.openSync(absolute, 'wx');
    try {
      if (content) {
        fsSync.writeFileSync(fd, content, { encoding: 'utf-8' });
      }
    } finally {
      fsSync.closeSync(fd);
    }
  }

  readSync(relativePath: string): string {
    const absolute = this.resolveAndCheck(relativePath, 'read');
    try {
      return fsSync.readFileSync(absolute, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw error;
    }
  }

  readBytesSync(relativePath: string, start: number, end: number): Buffer {
    const absolute = this.resolveAndCheck(relativePath, 'read');
    let fd: number;
    try {
      fd = fsSync.openSync(absolute, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw error;
    }
    try {
      const length = end - start;
      if (length <= 0) return Buffer.alloc(0);
      const buf = Buffer.alloc(length);
      const bytesRead = fsSync.readSync(fd, buf, 0, length, start);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    } finally {
      fsSync.closeSync(fd);
    }
  }

  appendSync(relativePath: string, content: string): void {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    const dir = path.dirname(absolute);
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.appendFileSync(absolute, content, 'utf-8');
  }

  moveSync(fromPath: string, toPath: string): void {
    const fromAbsolute = this.resolveAndCheck(fromPath, 'write');
    const toAbsolute = this.resolveAndCheck(toPath, 'write');
    fsSync.mkdirSync(path.dirname(toAbsolute), { recursive: true });
    fsSync.renameSync(fromAbsolute, toAbsolute);
  }

  existsSync(relativePath: string): boolean {
    const absolute = this.resolveAndCheck(relativePath, 'read');
    return fsSync.existsSync(absolute);
  }

  ensureDirSync(relativePath: string): void {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    fsSync.mkdirSync(absolute, { recursive: true });
  }

  listSync(relativePath: string, options?: {
    recursive?: boolean;
    includeDirs?: boolean;
    pattern?: string;
  }): FileEntry[] {
    const absolute = this.resolveAndCheck(relativePath, 'read');
    const stat = fsSync.statSync(absolute);
    if (!stat.isDirectory()) {
      throw new FileNotFoundError(relativePath);
    }
    const entries = fsSync.readdirSync(absolute, { withFileTypes: true });
    const results = entries
      .filter(e => options?.includeDirs ? true : e.isFile())
      .filter(e => {
        if (!options?.pattern) return true;
        const regex = new RegExp(options.pattern);
        return regex.test(e.name);
      })
      .map(e => {
        const fullPath = path.join(absolute, e.name);
        const stat = fsSync.statSync(fullPath);
        return {
          name: e.name,
          path: path.join(relativePath, e.name),
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
          size: stat.size,
          mtime: stat.mtime,
        };
      });
    return results;
  }

  statSync(relativePath: string): {
    size: number;
    mtime: Date;
    ctime: Date;
    isFile: boolean;
    isDirectory: boolean;
  } {
    const absolute = this.resolveAndCheck(relativePath, 'read');
    try {
      const s = fsSync.statSync(absolute);
      return {
        size: s.size,
        mtime: s.mtime,
        ctime: s.ctime,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw error;
    }
  }

  deleteSync(relativePath: string): void {
    const absolute = this.resolveAndCheck(relativePath, 'write');
    try {
      fsSync.unlinkSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(relativePath);
      }
      throw error;
    }
  }

  // ========================================================================
  // Cleanup
  // =======================================================================
  
  /**
   * Clean up orphaned temp files (call on startup)
   */
  async cleanupTempFiles(dirPath?: string): Promise<string[]> {
    const targetDir = dirPath ?? '.';
    const absolute = this.resolveAndCheck(targetDir, 'write');
    return cleanupOrphanedTemp(absolute);
  }

}
