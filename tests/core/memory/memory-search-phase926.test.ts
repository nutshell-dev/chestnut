/**
 * Phase 926 — memory_search skipped files visibility.
 */
import { describe, it, expect, vi } from 'vitest';
import { memorySearchTool } from '../../../src/core/memory/tools/memory_search.js';
import type { FileEntry, FileSystem } from '../../../src/foundation/fs/types.js';
import type { ExecutionInfra } from '../../../src/foundation/tools/types.js';

function makeMockInfra(entries: FileEntry[], readImpl: (path: string) => string): ExecutionInfra {
  return {
    fs: {
      list: vi.fn(async () => entries),
      read: vi.fn(async (path: string) => readImpl(path)),
    } as unknown as FileSystem,
  } as ExecutionInfra;
}

describe('memory_search phase926 skipped visibility', () => {
  it('reports skipped files in content when read throws non-ENOENT', async () => {
    const entries: FileEntry[] = [
      { path: 'memory/a.md', name: 'a.md', isDirectory: false, isFile: true },
      { path: 'memory/b.md', name: 'b.md', isDirectory: false, isFile: true },
      { path: 'memory/c.md', name: 'c.md', isDirectory: false, isFile: true },
    ];

    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const infra = makeMockInfra(entries, (path) => {
      if (path === 'memory/b.md') throw eacces;
      if (path === 'memory/a.md') return 'hello alpha';
      if (path === 'memory/c.md') return 'hello gamma';
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await memorySearchTool.execute({ query: 'hello' }, infra);

    expect(result.success).toBe(true);
    expect(result.content).toContain('hello alpha');
    expect(result.content).toContain('hello gamma');
    expect(result.content).toContain('1 个文件因读取错误被跳过');
  });

  it('keeps silently skipping on ENOENT (TOCTOU)', async () => {
    const entries: FileEntry[] = [
      { path: 'memory/a.md', name: 'a.md', isDirectory: false, isFile: true },
      { path: 'memory/b.md', name: 'b.md', isDirectory: false, isFile: true },
    ];

    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const infra = makeMockInfra(entries, (path) => {
      if (path === 'memory/b.md') throw enoent;
      if (path === 'memory/a.md') return 'hello alpha';
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await memorySearchTool.execute({ query: 'hello' }, infra);

    expect(result.success).toBe(true);
    expect(result.content).toContain('hello alpha');
    expect(result.content).not.toContain('文件因读取错误被跳过');
  });
});
