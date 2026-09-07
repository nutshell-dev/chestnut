import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import * as nodeFsPromises from 'node:fs/promises';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

// phase 1786: reconcile 测试隔离 —— getFallbackDir()=tmpdir() 走本 mock，
// malformed retention 用例重定向到独立目录，避免共享 tmpdir 跨测试文件竞态。
const realTmpdir = vi.hoisted(() => {
  const { tmpdir: fn } = require('node:os');
  return fn as () => string;
});
const mockTmpdir = vi.hoisted(() => vi.fn(() => realTmpdir()));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    tmpdir: mockTmpdir,
  };
});

// Must mock before importing the module-under-test (hoisted by vitest)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    // phase 1785: 默认 fsync 成功（既有用例走 durable 路径）；retention 用例各自覆盖 fsyncSync 行为
    openSync: vi.fn(() => 9999),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
  };
});

import { AuditWriter, _resetFallbackForTest, reconcileFallbackDumps } from '../../../src/foundation/audit/writer.js';
import * as nodeFs from 'node:fs';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeFailingFs(): FileSystem {
  return {
    appendSync: vi.fn(() => { throw new Error('EIO disk full'); }),
    statSync: vi.fn(() => ({ size: 0 } as any)),
    moveSync: vi.fn(),
  } as any;
}

describe('AuditWriter — fallback buffer origin tag (P1.13)', () => {
  let exitListeners: Array<() => void>;

  beforeEach(() => {
    _resetFallbackForTest();
    exitListeners = [];
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
      if (event === 'exit') exitListeners.push(handler);
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(nodeFs.writeFileSync).mockClear();
  });

  it('multiple AuditWriter instances tag fallback lines with origin filePath', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const writerA = new AuditWriter(makeFailingFs(), '/test/a.tsv');
    const writerB = new AuditWriter(makeFailingFs(), '/test/b.tsv');
    writerA.write('evt_a', 'col1');
    writerB.write('evt_b', 'col2');

    // exit handler 已注册
    expect(exitListeners).toHaveLength(1);

    // 触发 exit → dump 到 OS temp dir
    exitListeners[0]!();
    expect(nodeFs.writeFileSync).toHaveBeenCalledWith(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      expect.stringMatching(new RegExp(`^${escapeRegex(tmpdir())}/chestnut-audit-fallback-\\d+-\\d+\\.tsv$`)),
      expect.stringContaining('/test/a.tsv'),
    );
    const dumpedContent = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    expect(dumpedContent).toContain('/test/a.tsv');
    expect(dumpedContent).toContain('/test/b.tsv');
    expect(dumpedContent).toContain('evt_a');
    expect(dumpedContent).toContain('evt_b');

    consoleErrSpy.mockRestore();
  });

  it('overflow drop-oldest preserves origin information of remaining entries', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const writerA = new AuditWriter(makeFailingFs(), '/test/a.tsv');
    const writerB = new AuditWriter(makeFailingFs(), '/test/b.tsv');
    for (let i = 0; i < 1010; i++) {
      if (i % 2 === 0) {
        writerA.write('event', `i=${i}`);
      } else {
        writerB.write('event', `i=${i}`);
      }
    }

    exitListeners[0]!();
    expect(nodeFs.writeFileSync).toHaveBeenCalled();
    const dumpedContent = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    const allLines = dumpedContent.split('\n').filter(l => l.length > 0);
    const hasFrontmatter = allLines[0] && allLines[0].startsWith('# drop_count_since_last_dump=');
    const lines = hasFrontmatter ? allLines.slice(1) : allLines;
    expect(lines.length).toBe(1000);

    // 前 10 行（i=0..9，origin=a 交替）已 drop，剩余应同时含 a 和 b
    const originsA = lines.filter(l => l.startsWith('/test/a.tsv'));
    const originsB = lines.filter(l => l.startsWith('/test/b.tsv'));
    expect(originsA.length).toBeGreaterThan(0);
    expect(originsB.length).toBeGreaterThan(0);
    // 各 500 行（i=10..1009，偶数 a，奇数 b）
    expect(originsA.length).toBe(500);
    expect(originsB.length).toBe(500);

    consoleErrSpy.mockRestore();
  });

  it('dump body lines prefixed with esc(origin) to prevent tab pollution', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // origin 含 tab 字符
    const writer = new AuditWriter(makeFailingFs(), '/test/foo\tbar.tsv');
    writer.write('evt', 'col1');

    exitListeners[0]!();
    expect(nodeFs.writeFileSync).toHaveBeenCalled();
    const dumpedContent = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    // esc 将 tab 转义为 \t，所以内容中不应出现未转义的 tab（除了 origin 与 line 之间的分隔符）
    const allLines = dumpedContent.split('\n').filter(l => l.length > 0);
    const hasFrontmatter = allLines[0] && allLines[0].startsWith('# drop_count_since_last_dump=');
    const firstLine = hasFrontmatter ? allLines[1] : allLines[0];
    // 格式: <esc(origin)>\t<line>
    // origin 中的真实 tab 已被转义为 \t，所以 firstLine 中不应包含 '/test/foo\tbar.tsv' 的未转义形式
    expect(firstLine).toContain('/test/foo\\tbar.tsv');
    // 且整行中，origin 部分与 line 部分只由一个真实 tab 分隔
    // 数真实 tab 数量：应该是 4（origin 和 line 之间的分隔 + line 内部的 3 个 tab：ts, seq, type, col）
    const realTabs = (firstLine.match(/\t/g) || []).length;
    expect(realTabs).toBe(4);

    consoleErrSpy.mockRestore();
  });
});

/**
 * Phase 1786: reconcile 遇到 malformed fallback 行（无 tab 分隔符）必须保留原始信息
 * 并显式报告 —— typed evidence（path/lineNo/raw/reason）+ quarantine 回写 +
 * 存在 malformed 时不得删除原 dump（即使其余 origin 全部回放成功）。
 *
 * 本文件 node:fs mock 只替换 writeFileSync/openSync/fsyncSync/closeSync；
 * readdirSync/readFileSync/unlinkSync/renameSync 与 node:fs/promises 为真实实现，
 * 因此 dump 用真实 tmpdir 文件（与 fallback-periodic-reconcile 同 pattern）。
 */
describe('reconcileFallbackDumps — malformed line retention (phase 1786)', () => {
  let dumpDir: string;
  const dumpPaths: string[] = [];
  let dumpSeq = 0;

  beforeEach(async () => {
    // 独立 reconcile 扫描目录（tmpdir mock 重定向），与并行测试文件零共享
    dumpDir = await nodeFsPromises.mkdtemp(`${realTmpdir()}/chestnut-reconcile-1786-`);
    mockTmpdir.mockImplementation(() => dumpDir);
  });

  async function writeDump(lines: string[]): Promise<string> {
    let ts = Date.now() * 100 + (dumpSeq++);
    let p = `${dumpDir}/chestnut-audit-fallback-${process.pid}-${ts}.tsv`;
    while (nodeFs.existsSync(p)) {
      ts++;
      p = `${dumpDir}/chestnut-audit-fallback-${process.pid}-${ts}.tsv`;
    }
    await nodeFsPromises.writeFile(p, lines.join('\n') + '\n');
    dumpPaths.push(p);
    return p;
  }

  function makeOkFs(appended: Map<string, string>): FileSystem {
    return {
      appendSync: vi.fn((origin: string, content: string) => {
        appended.set(origin, (appended.get(origin) || '') + content);
      }),
      syncSync: vi.fn(),
    } as any;
  }

  afterEach(async () => {
    mockTmpdir.mockImplementation(() => realTmpdir());
    try { await nodeFsPromises.rm(dumpDir, { recursive: true, force: true }); } catch { /* silent: test cleanup */ }
    dumpPaths.length = 0;
    vi.restoreAllMocks();
  });

  it('malformed 行 typed evidence + 其余 origin 成功也不删 dump', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dumpPath = await writeDump([
      '/test/a.tsv\t2026-09-07T10:00:00.000Z\tevt_a\tcol1',
      'MALFORMED NO TAB LINE',
      '/test/b.tsv\t2026-09-07T10:00:01.000Z\tevt_b\tcol2',
    ]);
    const appended = new Map<string, string>();

    const result = await reconcileFallbackDumps(makeOkFs(appended));

    // valid 行照常回放
    expect(appended.get('/test/a.tsv')).toContain('evt_a');
    expect(appended.get('/test/b.tsv')).toContain('evt_b');
    // reconcile 结果非成功 + typed evidence（path/lineNo/raw/reason）
    expect(result.ok).toBe(false);
    expect(result.scanned).toBe(1);
    expect(result.retained).toBe(1);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]).toEqual({
      kind: 'malformed',
      path: dumpPath,
      lineNo: 2,
      raw: 'MALFORMED NO TAB LINE',
      reason: 'missing origin tab separator',
    });
    // 原 dump 保留不删（唯一证据不丢）；quarantine 回写含 raw 原文
    expect(nodeFs.existsSync(dumpPath)).toBe(true);
    const rewritten = await nodeFsPromises.readFile(dumpPath, 'utf8');
    expect(rewritten).toContain('MALFORMED NO TAB LINE');
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[AUDIT WARNING\] reconcile fallback malformed lines retained: .*count=1.*lines=#2/),
    );
  });

  it('frontmatter 存在时 malformed lineNo 为原始文件行号', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dumpPath = await writeDump([
      '# drop_count_since_last_dump=0 drop_count_total=3 first_drop_ts=100 last_drop_ts=200',
      '/test/a.tsv\t2026-09-07T10:00:00.000Z\tevt_a\tcol1',
      'garbage-line-without-tab',
    ]);

    const result = await reconcileFallbackDumps(makeOkFs(new Map()));

    expect(result.ok).toBe(false);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0].path).toBe(dumpPath);
    expect(result.malformed[0].lineNo).toBe(3);
    expect(result.malformed[0].raw).toBe('garbage-line-without-tab');
    expect(nodeFs.existsSync(dumpPath)).toBe(true);
  });

  it('全部 valid → dump 删除、零 malformed（对照）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dumpPath = await writeDump([
      '/test/a.tsv\t2026-09-07T10:00:00.000Z\tevt_a\tcol1',
    ]);
    const appended = new Map<string, string>();

    const result = await reconcileFallbackDumps(makeOkFs(appended));

    expect(appended.get('/test/a.tsv')).toContain('evt_a');
    expect(result).toMatchObject({ ok: true, scanned: 1, retained: 0 });
    expect(result.malformed).toHaveLength(0);
    expect(nodeFs.existsSync(dumpPath)).toBe(false);
  });

  it('quarantine 幂等：下轮 reconcile 仍保留并报同一 raw 行（不丢不重复回放）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dumpPath = await writeDump([
      '/test/a.tsv\t2026-09-07T10:00:00.000Z\tevt_a\tcol1',
      'STUCK MALFORMED',
    ]);
    const appended = new Map<string, string>();

    const first = await reconcileFallbackDumps(makeOkFs(appended));
    expect(first.ok).toBe(false);
    expect(first.malformed).toHaveLength(1);
    // valid 行已回放并核销（quarantine 回写只含 malformed raw）
    const second = await reconcileFallbackDumps(makeOkFs(appended));
    expect(second.ok).toBe(false);
    expect(second.malformed).toHaveLength(1);
    expect(second.malformed[0].raw).toBe('STUCK MALFORMED');
    expect(second.malformed[0].lineNo).toBe(1);
    expect(nodeFs.existsSync(dumpPath)).toBe(true);
    // evt_a 只回放一次（首轮），第二轮无重复
    expect(appended.get('/test/a.tsv')).toBe('2026-09-07T10:00:00.000Z\tevt_a\tcol1\n');
  });
});

/**
 * Phase 1787: reconcile origin sync 失败（append 已写入、耐久未确认）必须参与 delete gate——
 * 阻止 dump 删除、lines 重写回 dump 保留下轮证据，typed per-origin stage 证据进 result.dumps。
 */
describe('reconcileFallbackDumps — phase 1787 sync failure delete gate', () => {
  let dumpDir: string;

  beforeEach(async () => {
    _resetFallbackForTest();
    // 独立 reconcile 扫描目录（与 phase 1786 同 mockTmpdir 重定向 pattern）
    dumpDir = await nodeFsPromises.mkdtemp(`${realTmpdir()}/chestnut-reconcile-1787-`);
    mockTmpdir.mockImplementation(() => dumpDir);
  });

  afterEach(async () => {
    mockTmpdir.mockImplementation(() => realTmpdir());
    try { await nodeFsPromises.rm(dumpDir, { recursive: true, force: true }); } catch { /* silent: test cleanup */ }
    vi.restoreAllMocks();
  });

  it('origin sync 失败 → 阻止 dump 删除 + 该 origin 行重写回 dump + typed failed{stage:sync} 报告', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dumpPath = `${dumpDir}/chestnut-audit-fallback-111-222.tsv`;
    await nodeFsPromises.writeFile(dumpPath, '/ok/a.tsv\tevt_a\tcol\n/bad/b.tsv\tevt_b\tcol\n');
    const syncErr = new Error('EIO fsync');
    const mockFs = {
      appendSync: vi.fn(async () => {}),
      syncSync: vi.fn((p: string) => { if (p === '/bad/b.tsv') throw syncErr; }),
    } as unknown as FileSystem;

    const result = await reconcileFallbackDumps(mockFs);

    // 1786 aggregate：非成功 + retained
    expect(result.ok).toBe(false);
    expect(result.scanned).toBe(1);
    expect(result.retained).toBe(1);
    // 1787 per-dump typed outcome：deleted=false + per-origin stage 证据（成功 origin 不掩盖失败 origin）
    expect(result.dumps).toHaveLength(1);
    const report = result.dumps[0]!;
    expect(report.path).toBe(dumpPath);
    expect(report.deleted).toBe(false);
    expect(report.origins).toContainEqual({ kind: 'durable', origin: '/ok/a.tsv' });
    expect(report.origins).toContainEqual({ kind: 'failed', origin: '/bad/b.tsv', stage: 'sync', error: syncErr });

    // 唯一未确认耐久证据未删除；重写后只留 sync-failed origin 行
    expect(nodeFs.existsSync(dumpPath)).toBe(true);
    const remaining = nodeFs.readFileSync(dumpPath, 'utf8');
    expect(remaining).toContain('/bad/b.tsv');
    expect(remaining).not.toContain('/ok/a.tsv');

    // console 证据留痕（reconcile 自身不可递归走 audit）
    expect(consoleErrSpy.mock.calls.some(c => String(c[0]).includes('reconcile fallback fsync failed'))).toBe(true);
    consoleErrSpy.mockRestore();
  });

  it('全部 origin durable → dump 删除 + typed deleted 报告', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dumpPath = `${dumpDir}/chestnut-audit-fallback-333-444.tsv`;
    await nodeFsPromises.writeFile(dumpPath, '/ok/a.tsv\tevt_a\tcol\n');
    const mockFs = {
      appendSync: vi.fn(async () => {}),
      syncSync: vi.fn(),
    } as unknown as FileSystem;

    const result = await reconcileFallbackDumps(mockFs);

    expect(result.ok).toBe(true);
    expect(result.dumps).toEqual([{
      path: dumpPath,
      deleted: true,
      origins: [{ kind: 'durable', origin: '/ok/a.tsv' }],
    }]);
    expect(nodeFs.existsSync(dumpPath)).toBe(false);
  });
});
