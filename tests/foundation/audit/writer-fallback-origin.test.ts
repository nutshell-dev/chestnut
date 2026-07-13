import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

// Must mock before importing the module-under-test (hoisted by vitest)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
  };
});

import { AuditWriter, _resetFallbackForTest } from '../../../src/foundation/audit/writer.js';
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
