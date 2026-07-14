import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { FileNotFoundError, isFileNotFound, PathGuardError } from '../../../src/foundation/fs/types.js';

describe('fs/node-fs.ts: no _operation param', () => {
  it('resolveAndCheck does not take _operation parameter', () => {
    const src = readFileSync('src/foundation/fs/node-fs.ts', 'utf-8');
    expect(src).not.toMatch(/_operation/);
  });

  it('types.ts does not reference _operation', () => {
    const src = readFileSync('src/foundation/fs/types.ts', 'utf-8');
    expect(src).not.toMatch(/_operation/);
  });
});

describe('fs/types.ts: list pattern comment accuracy', () => {
  it('does not contain "glob pattern" comment', () => {
    const src = readFileSync('src/foundation/fs/types.ts', 'utf-8');
    expect(src).not.toMatch(/glob pattern/);
  });

  it('contains "regular expression pattern" comment', () => {
    const src = readFileSync('src/foundation/fs/types.ts', 'utf-8');
    expect(src).toMatch(/regular expression pattern/);
  });
});

describe('fs/types.ts JSDoc', () => {
  it('does not contain "claw space" in JSDoc comments (M#5 generic)', () => {
    const content = fs.readFileSync(
      path.resolve(process.cwd(), 'src/foundation/fs/types.ts'),
      'utf-8'
    );
    // Remove PathNotInClawSpaceError class name references (those are identifiers, not doc concept)
    const withoutClassName = content.replace(/PathNotInClawSpaceError/g, '');
    expect(withoutClassName).not.toContain('claw space');
  });
});

describe('fs/node-fs.ts: writeAtomicSync uses IGNORE_PATTERN', () => {
  it('does not contain hardcoded .tmp_ literal in writeAtomicSync', () => {
    const src = readFileSync('src/foundation/fs/node-fs.ts', 'utf-8');
    // Allow IGNORE_PATTERN definition in atomic.ts, but node-fs.ts should reference the constant
    expect(src).not.toMatch(/`\.tmp_\$\{randomUUID\(\)\}`/);
    expect(src).not.toMatch(/"\.tmp_"\+randomUUID/);
    expect(src).not.toMatch(/'\.tmp_'\+randomUUID/);
    expect(src).not.toMatch(/\.tmp_\$\{randomUUID\(\)\}/);
    expect(src).not.toMatch(/`\.tmp_\$\{newUuid\(\)\}`/);
    expect(src).not.toMatch(/"\.tmp_"\+newUuid/);
    expect(src).not.toMatch(/'\.tmp_'\+newUuid/);
    expect(src).not.toMatch(/\.tmp_\$\{newUuid\(\)\}/);
  });

  it('imports IGNORE_PATTERN from atomic.js', () => {
    const src = readFileSync('src/foundation/fs/node-fs.ts', 'utf-8');
    expect(src).toMatch(/IGNORE_PATTERN/);
  });

  it('uses IGNORE_PATTERN in tmp file naming', () => {
    const src = readFileSync('src/foundation/fs/node-fs.ts', 'utf-8');
    expect(src).toMatch(/\$\{IGNORE_PATTERN\}\$\{newUuid\(\)\}/);
  });
});

describe('NodeFileSystem — exists PathGuardError signal (P1.5 phase 611)', () => {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const fs = new NodeFileSystem({ baseDir: os.tmpdir() });

  it('throws PathGuardError when probing absolute path', async () => {
    // 修前：catch all 返 false / probing /etc/passwd 静默返 false
    // 修后：PathGuardError 抛 / 安全 signal 保留
    await expect(fs.exists('/etc/passwd')).rejects.toThrow(PathGuardError);
  });

  it('returns false for legitimate non-existent relative path', async () => {
    expect(await fs.exists('definitely-not-exists.txt')).toBe(false);
  });

  it('returns true for existing relative path', async () => {
    // setup: write tmp file in baseDir
    const tmpName = `phase611-${Date.now()}.txt`;
    await fs.writeAtomic(tmpName, 'data');
    expect(await fs.exists(tmpName)).toBe(true);
    // cleanup
    await fs.delete(tmpName).catch(() => { /* silent: cleanup */ });
  });
});

/**
 * Phase 1154 α-1 — isFileNotFound helper 反向测试
 *
 * 反向 4 项:
 *   (1) FileNotFoundError instance → true
 *   (2) NodeJS.ErrnoException 含 code='ENOENT' → true
 *   (3) 不相关 Error / null / undefined / { code: 'EACCES' } → false
 *   (4) { code: 'FS_NOT_FOUND' } plain object → false（仅 instanceof 路径或 ENOENT 字符串）
 */
describe('isFileNotFound helper', () => {
  it('returns true for FileNotFoundError instance', () => {
    const err = new FileNotFoundError('/some/path');
    expect(isFileNotFound(err)).toBe(true);
  });

  it('returns true for NodeJS.ErrnoException with code ENOENT', () => {
    const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    expect(isFileNotFound(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isFileNotFound(new Error('random'))).toBe(false);
    expect(isFileNotFound(null)).toBe(false);
    expect(isFileNotFound(undefined)).toBe(false);
    expect(isFileNotFound({ code: 'EACCES' })).toBe(false);
    expect(isFileNotFound({ code: 'ENOTDIR' })).toBe(false);
  });

  it('returns false for plain object with code FS_NOT_FOUND (not instanceof)', () => {
    expect(isFileNotFound({ code: 'FS_NOT_FOUND' })).toBe(false);
  });
});

describe('NodeFileSystem — absolute path reject (P0.1 phase 611)', () => {
  // baseDir 用唯一子目录、保所有平台 /tmp/escape /etc/passwd /nonexistent/sensitive 都在 baseDir 外
  // 修前 baseDir = os.tmpdir() / Linux CI 上 = '/tmp' / 致 /tmp/escape 误在 baseDir 内
  // (phase 739 step B fix)
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const baseDir = path.join(os.tmpdir(), `nodefs-abs-reject-${randomUUID()}`);
  const fs = new NodeFileSystem({ baseDir });

  it('throws PathGuardError for absolute POSIX path /etc/passwd', async () => {
    await expect(fs.read('/etc/passwd')).rejects.toThrow(PathGuardError);
  });

  it('throws PathGuardError for absolute path even when file does not exist', async () => {
    // Path #1 实证 attack vector：read + 不存在文件 + 绝对路径 → 修前 fall through silent
    await expect(fs.read('/nonexistent/sensitive')).rejects.toThrow(PathGuardError);
  });

  it('throws PathGuardError for write with absolute path', async () => {
    await expect(fs.writeAtomic('/tmp/escape', 'data')).rejects.toThrow(PathGuardError);
  });

  it('does not affect legitimate relative paths', async () => {
    // baseDir = os.tmpdir() / relative path 'sub/file' 应 0 throw
    // (file 不存在 → read 抛 FileNotFoundError 非 PathGuardError)
    const { FileNotFoundError } = await import('../../../src/foundation/fs/types.js');
    await expect(fs.read('sub/file')).rejects.toThrow(FileNotFoundError);
  });
});
