import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import * as nodeOs from 'node:os';
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

describe('AuditWriter fallback buffer (phase 586 / α)', () => {
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

  it('append 失败时 line 入 fallback buffer + exit 时 dump 到 OS temp dir', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    writer.write('test_event', 'col1', 'col2');

    // append 失败 → console.error [AUDIT CRITICAL] write failed
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[AUDIT CRITICAL\] write failed: type=test_event/),
    );

    // exit handler 已注册
    expect(exitListeners).toHaveLength(1);

    // 触发 exit → dump 到 OS temp dir
    exitListeners[0]!();
    expect(nodeFs.writeFileSync).toHaveBeenCalledWith(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      expect.stringMatching(new RegExp(`^${escapeRegex(tmpdir())}/chestnut-audit-fallback-\\d+-\\d+\\.tsv$`)),
      expect.stringContaining('test_event'),
    );
  });

  it('overflow 超 cap 1000 时 FIFO drop-oldest + 首次溢出 1 次 console.error meta', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    for (let i = 0; i < 1001; i++) {
      writer.write('event', `i=${i}`);
    }

    // overflow meta 1 次（首次）
    const overflowCalls = consoleErrSpy.mock.calls.filter((c: any[]) =>
      typeof c[0] === 'string' && c[0].includes('fallback buffer overflow')
    );
    expect(overflowCalls).toHaveLength(1);

    // dump 验证：buffer 有 1000 行（drop oldest），兼容 frontmatter
    exitListeners[0]!();
    expect(nodeFs.writeFileSync).toHaveBeenCalled();
    const dumpedContent = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    const allLines = dumpedContent.split('\n').filter(l => l.length > 0);
    const hasFrontmatter = allLines[0] && allLines[0].startsWith('# drop_count_since_last_dump=');
    const lineCount = hasFrontmatter ? allLines.length - 1 : allLines.length;
    expect(lineCount).toBe(1000);
  });

  it('exit handler 模块-level once-init / 多 instance 仅注册一次', () => {
    new AuditWriter(makeFailingFs(), '/test/a.tsv').write('e1');
    new AuditWriter(makeFailingFs(), '/test/b.tsv').write('e2');
    expect(exitListeners).toHaveLength(1);   // 模块-level guard 起效
  });

  it('FALLBACK_DIR 由 os.tmpdir() derive cross-platform (反向: mock tmpdir → fallbackPath 含 mock 前缀)', async () => {
    vi.doMock('node:os', () => ({ tmpdir: () => '/mock-tmp-dir' }));
    vi.resetModules();
    const { AuditWriter: AW, _resetFallbackForTest: reset } = await import('../../../src/foundation/audit/writer.js');
    reset();

    const listeners: Array<() => void> = [];
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
      if (event === 'exit') listeners.push(handler);
      return process;
    });

    const writer = new AW(makeFailingFs(), '/test/audit.tsv');
    writer.write('test_event', 'col1');

    listeners[0]!();
    expect(nodeFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock-tmp-dir\/chestnut-audit-fallback-\d+-\d+\.tsv$/),
      expect.any(String),
    );

    vi.doUnmock('node:os');
    vi.resetModules();
  });
});
