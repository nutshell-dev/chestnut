import { FileNotFoundError } from '../../types/errors.js';
import type { IFileSystem } from '../fs/types.js';

export class AuditWriter {
  private maxBytes: number | null;

  constructor(
    private fs: IFileSystem,
    private filePath: string,
    maxSizeMb?: number | null,
  ) {
    this.maxBytes = maxSizeMb ? maxSizeMb * 1024 * 1024 : null;
  }

  getFs(): IFileSystem {
    return this.fs;
  }

  write(type: string, ...cols: (string | number)[]): void {
    const ts = new Date().toISOString();
    const parts = [ts, type, ...cols.map(c => esc(String(c)))];
    const line = parts.join('\t') + '\n';
    try {
      if (this.maxBytes) this.rotateIfNeeded();
      this.fs.appendSync(this.filePath, line);
    } catch (err) {
      console.warn('[audit] write failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stats = this.fs.statSync(this.filePath);
      if (stats.size >= this.maxBytes!) {
        this.fs.moveSync(this.filePath, `${this.filePath}.${Date.now()}.bak`);
      }
    } catch (err) {
      // FileNotFoundError（首次写入文件不存在）静默跳过；其他错误 warn
      if (!(err instanceof FileNotFoundError)) {
        console.warn('[audit] rotation check failed:', err instanceof Error ? err.message : String(err));
      }
    }
  }
}

function esc(s: string): string {
  return s.replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}
