/**
 * Phase 1753 — AtomicWriteResult 三态协议故障注入测试
 *
 * 覆盖（async/sync 对称）：
 * - rename 后 parent-dir fsync 成功 → { kind: 'durable' }
 * - 已知平台不支持码（EPERM）→ committed_platform_limited（保留 error 证据、内容已提交）
 * - 未知真实 I/O 故障（EIO）→ committed_durability_unknown（保留 error 证据、内容已提交）
 * - rename 前 temp 写入失败 → 原异常抛出、无结果返回（不能声称已提交）
 *
 * 注入手法：vi.mock('fs') 包装 promises.open / openSync / writeFile / writeFileSync，
 * 仅当 per-test 注入变量 armed 且命中目标调用（dir r-open / tmp write）时抛注入错误，
 * 其余调用直通真实实现（照 exdev-fallback.test.ts 模式）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { promises as fs, type PathLike, type OpenMode } from 'fs';
import * as fsSync from 'fs';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

interface InjectionState {
  /** rename 后 dir r-open 注入错误（null = 不注入） */
  dirOpenFailure: NodeJS.ErrnoException | null;
  /** rename 前 tmp write 注入错误（null = 不注入） */
  tmpWriteFailure: NodeJS.ErrnoException | null;
}

const injection: InjectionState = { dirOpenFailure: null, tmpWriteFailure: null };

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code });
}

// tmp 文件命名约定（IGNORE_PATTERN）——只注入 tmp 写入、不影响其他 writeFile 调用方
function isTmpPath(p: unknown): boolean {
  return typeof p === 'string' && path.basename(p).startsWith('.tmp_');
}

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      open: (async (p: PathLike, flags: OpenMode, ...rest: unknown[]) => {
        // atomic write 的 parent-dir open 以 'r' 出现；tmp 文件是 'r+'
        if (flags === 'r' && injection.dirOpenFailure) throw injection.dirOpenFailure;
        return (actual.promises.open as unknown as (...a: unknown[]) => Promise<unknown>)(p, flags, ...rest);
      }) as typeof actual.promises.open,
      writeFile: (async (p: PathLike, ...rest: unknown[]) => {
        if (injection.tmpWriteFailure && isTmpPath(p)) throw injection.tmpWriteFailure;
        return (actual.promises.writeFile as unknown as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      }) as typeof actual.promises.writeFile,
    },
    openSync: ((p: PathLike, flags: OpenMode, ...rest: unknown[]) => {
      if (flags === 'r' && injection.dirOpenFailure) throw injection.dirOpenFailure;
      return (actual.openSync as unknown as (...a: unknown[]) => unknown)(p, flags, ...rest);
    }) as typeof actual.openSync,
    writeFileSync: ((p: PathLike, ...rest: unknown[]) => {
      if (injection.tmpWriteFailure && isTmpPath(p)) throw injection.tmpWriteFailure;
      return (actual.writeFileSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof actual.writeFileSync,
  };
});

async function setup(): Promise<{ tmpDir: string; nodeFs: NodeFileSystem }> {
  const tmpDir = fsSync.realpathSync(await createTrackedTempDir('fs-atomic-write-result-'));
  const nodeFs = new NodeFileSystem({ baseDir: tmpDir });
  return { tmpDir, nodeFs };
}

beforeEach(() => {
  injection.dirOpenFailure = null;
  injection.tmpWriteFailure = null;
});

describe('phase 1753: AtomicWriteResult protocol (async writeAtomic)', () => {
  it('returns durable when parent-dir fsync succeeds', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      const result = await nodeFs.writeAtomic('a.txt', 'hello-async');
      expect(result).toEqual({ kind: 'durable' });
      expect(await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf-8')).toBe('hello-async');
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });

  it('returns committed_platform_limited with error evidence on known unsupported code', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      injection.dirOpenFailure = errnoError('EPERM');

      const result = await nodeFs.writeAtomic('b.txt', 'hello-platform');

      expect(result.kind).toBe('committed_platform_limited');
      if (result.kind === 'committed_platform_limited') {
        expect(result.error.code).toBe('EPERM');
      }
      // rename 已提交事实：内容可见
      expect(await fs.readFile(path.join(tmpDir, 'b.txt'), 'utf-8')).toBe('hello-platform');
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });

  it('returns committed_durability_unknown with error evidence on unexpected fsync failure', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      injection.dirOpenFailure = errnoError('EIO');

      const result = await nodeFs.writeAtomic('c.txt', 'hello-unknown');

      expect(result.kind).toBe('committed_durability_unknown');
      if (result.kind === 'committed_durability_unknown') {
        expect(result.error.code).toBe('EIO');
      }
      // rename 已提交事实：内容可见
      expect(await fs.readFile(path.join(tmpDir, 'c.txt'), 'utf-8')).toBe('hello-unknown');
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });

  it('throws the original error when temp write fails before rename', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      injection.tmpWriteFailure = errnoError('ENOSPC');

      await expect(nodeFs.writeAtomic('d.txt', 'will-not-commit')).rejects.toMatchObject({
        code: 'ENOSPC',
      });
      // rename 未发生：目标不存在
      await expect(fs.access(path.join(tmpDir, 'd.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });

  it('writeAtomicExisting forwards the three-state result', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      await nodeFs.ensureDir('sub');
      const durable = await nodeFs.writeAtomicExisting(path.join('sub', 'e.txt'), 'existing-parent');
      expect(durable).toEqual({ kind: 'durable' });

      injection.dirOpenFailure = errnoError('EACCES');
      const limited = await nodeFs.writeAtomicExisting(path.join('sub', 'f.txt'), 'existing-parent-2');
      expect(limited.kind).toBe('committed_platform_limited');
      if (limited.kind === 'committed_platform_limited') {
        expect(limited.error.code).toBe('EACCES');
      }
      expect(await fs.readFile(path.join(tmpDir, 'sub', 'f.txt'), 'utf-8')).toBe('existing-parent-2');
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });
});

describe('phase 1753: AtomicWriteResult protocol (sync writeAtomicSync, symmetric)', () => {
  it('returns durable when parent-dir fsync succeeds', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      const result = nodeFs.writeAtomicSync('sa.txt', 'hello-sync');
      expect(result).toEqual({ kind: 'durable' });
      expect(fsSync.readFileSync(path.join(tmpDir, 'sa.txt'), 'utf-8')).toBe('hello-sync');
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });

  it('returns committed_platform_limited with error evidence on known unsupported code', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      injection.dirOpenFailure = errnoError('EINVAL');

      const result = nodeFs.writeAtomicSync('sb.txt', 'hello-sync-platform');

      expect(result.kind).toBe('committed_platform_limited');
      if (result.kind === 'committed_platform_limited') {
        expect(result.error.code).toBe('EINVAL');
      }
      expect(fsSync.readFileSync(path.join(tmpDir, 'sb.txt'), 'utf-8')).toBe('hello-sync-platform');
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });

  it('returns committed_durability_unknown with error evidence on unexpected fsync failure', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      injection.dirOpenFailure = errnoError('EIO');

      const result = nodeFs.writeAtomicSync('sc.txt', 'hello-sync-unknown');

      expect(result.kind).toBe('committed_durability_unknown');
      if (result.kind === 'committed_durability_unknown') {
        expect(result.error.code).toBe('EIO');
      }
      expect(fsSync.readFileSync(path.join(tmpDir, 'sc.txt'), 'utf-8')).toBe('hello-sync-unknown');
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });

  it('throws the original error when temp write fails before rename', async () => {
    const { tmpDir, nodeFs } = await setup();
    try {
      injection.tmpWriteFailure = errnoError('ENOSPC');

      let thrown: unknown;
      try {
        nodeFs.writeAtomicSync('sd.txt', 'will-not-commit');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: 'ENOSPC' });
      expect(fsSync.existsSync(path.join(tmpDir, 'sd.txt'))).toBe(false);
    } finally {
      await cleanupTempDir(tmpDir);
    }
  });
});
