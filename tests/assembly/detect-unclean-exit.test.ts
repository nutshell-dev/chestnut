import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockExistsSync = vi.fn();
let mockStatSync = vi.fn();
let mockOpenSync = vi.fn();
let mockReadSync = vi.fn();
let mockCloseSync = vi.fn();

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    statSync: (...args: any[]) => mockStatSync(...args),
    openSync: (...args: any[]) => mockOpenSync(...args),
    readSync: (...args: any[]) => mockReadSync(...args),
    closeSync: (...args: any[]) => mockCloseSync(...args),
  };
});

import { detectUncleanExit } from '../../src/assembly/assemble.js';

describe('detectUncleanExit catch audit', () => {
  beforeEach(() => {
    mockExistsSync = vi.fn();
    mockStatSync = vi.fn();
    mockOpenSync = vi.fn();
    mockReadSync = vi.fn();
    mockCloseSync = vi.fn();
  });

  it('audits ASSEMBLE_FAILED on non-ENOENT error', () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation(() => {
      const err = new Error('EACCES') as any;
      err.code = 'EACCES';
      throw err;
    });

    const mockFs = { existsSync: mockExistsSync, statSync: mockStatSync };
    detectUncleanExit('/tmp/audit', audit as any, mockFs as any);

    expect(audit.write).toHaveBeenCalledWith(
      'assemble_failed',
      'module=detect_unclean_exit',
      'phase=detect',
      expect.stringMatching(/reason=EACCES/),
    );
  });

  it('skips ENOENT (graceful / no audit)', () => {
    const audit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
    mockExistsSync.mockReturnValue(true);
    mockStatSync.mockImplementation(() => {
      const err = new Error('ENOENT') as any;
      err.code = 'ENOENT';
      throw err;
    });

    const mockFs = { existsSync: mockExistsSync, statSync: mockStatSync };
    detectUncleanExit('/tmp/audit', audit as any, mockFs as any);

    expect(audit.write).not.toHaveBeenCalled();
  });
});
