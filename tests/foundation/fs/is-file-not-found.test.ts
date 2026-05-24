/**
 * Phase 1154 α-1 — isFileNotFound helper 反向测试
 *
 * 反向 4 项:
 *   (1) FileNotFoundError instance → true
 *   (2) NodeJS.ErrnoException 含 code='ENOENT' → true
 *   (3) 不相关 Error / null / undefined / { code: 'EACCES' } → false
 *   (4) { code: 'FS_NOT_FOUND' } plain object → false（仅 instanceof 路径或 ENOENT 字符串）
 */
import { describe, it, expect } from 'vitest';
import { FileNotFoundError, isFileNotFound } from '../../../src/foundation/fs/types.js';

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
