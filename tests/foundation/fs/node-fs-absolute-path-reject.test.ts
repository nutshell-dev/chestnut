import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { PermissionError } from '../../../src/foundation/errors.js';

describe('NodeFileSystem — absolute path reject (P0.1 phase 611)', () => {
  // baseDir 用唯一子目录、保所有平台 /tmp/escape /etc/passwd /nonexistent/sensitive 都在 baseDir 外
  // 修前 baseDir = os.tmpdir() / Linux CI 上 = '/tmp' / 致 /tmp/escape 误在 baseDir 内
  // (phase 739 step B fix)
  const baseDir = path.join(os.tmpdir(), `nodefs-abs-reject-${randomUUID()}`);
  const fs = new NodeFileSystem({ baseDir });

  it('throws PermissionError for absolute POSIX path /etc/passwd', async () => {
    await expect(fs.read('/etc/passwd')).rejects.toThrow(PermissionError);
  });

  it('throws PermissionError for absolute path even when file does not exist', async () => {
    // Path #1 实证 attack vector：read + 不存在文件 + 绝对路径 → 修前 fall through silent
    await expect(fs.read('/nonexistent/sensitive')).rejects.toThrow(PermissionError);
  });

  it('throws PermissionError for write with absolute path', async () => {
    await expect(fs.writeAtomic('/tmp/escape', 'data')).rejects.toThrow(PermissionError);
  });

  it('does not affect legitimate relative paths', async () => {
    // baseDir = os.tmpdir() / relative path 'sub/file' 应 0 throw
    // (file 不存在 → read 抛 FileNotFoundError 非 PermissionError)
    const { FileNotFoundError } = await import('../../../src/foundation/fs/types.js');
    await expect(fs.read('sub/file')).rejects.toThrow(FileNotFoundError);
  });
});
