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
    // phase 1785: 默认 fsync 成功（既有用例走 durable 路径）；retention 用例各自覆盖 fsyncSync 行为
    openSync: vi.fn(() => 9999),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
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

  it('exit handler 模块-level once-init / 多 instance 仅注册一次', () => {    new AuditWriter(makeFailingFs(), '/test/a.tsv').write('e1');
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

describe('AuditWriter fallback fsync failure retention (phase 1785)', () => {
  let exitListeners: Array<() => void>;

  beforeEach(() => {
    _resetFallbackForTest();
    exitListeners = [];
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: any) => {
      if (event === 'exit') exitListeners.push(handler);
      return process;
    });
    vi.mocked(nodeFs.fsyncSync).mockReset().mockImplementation(() => {});
    vi.mocked(nodeFs.openSync).mockReset().mockImplementation(() => 9999 as any);
    vi.mocked(nodeFs.closeSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(nodeFs.writeFileSync).mockClear();
  });

  it('fsync 失败 → pending_retry：batch 内存副本保留、不重复 dump、typed outcome 带 path/error/entries', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncErr = Object.assign(new Error('fsync EIO'), { code: 'EIO' });
    vi.mocked(nodeFs.fsyncSync).mockImplementation(() => { throw syncErr; });

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    writer.write('test_event', 'col1');

    const outcome = writer.dispose();
    expect(outcome).toEqual({
      kind: 'pending_retry',
      path: expect.stringMatching(/chestnut-audit-fallback-\d+-\d+\.tsv$/),
      error: syncErr,
      entries: 1,
    });
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[AUDIT WARNING\] fallback fsync failed: .*batch retained \(pending_retry\), no re-dump$/),
    );

    // 再次 dispose：retry 同 path fsync（仍失败）——不重复 writeFileSync（无重复 dump）
    vi.mocked(nodeFs.writeFileSync).mockClear();
    const retryOutcome = writer.dispose();
    expect(retryOutcome?.kind).toBe('pending_retry');
    expect(nodeFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('fsync 重试成功 → 追认 durable：清空内存副本、核销已记录 drop metadata、不重 dump retained batch', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncErr = Object.assign(new Error('fsync EIO'), { code: 'EIO' });
    vi.mocked(nodeFs.fsyncSync).mockImplementation(() => { throw syncErr; });

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    writer.write('first_batch_event', 'col1');
    const first = writer.dispose();
    expect(first?.kind).toBe('pending_retry');

    // fsync 恢复 → dispose 触发 retry → 追认耐久
    vi.mocked(nodeFs.fsyncSync).mockImplementation(() => {});
    vi.mocked(nodeFs.writeFileSync).mockClear();
    const recovered = writer.dispose();
    // slot 追认后无新 batch → 返回 null（无新 dump）
    expect(recovered).toBeNull();
    expect(nodeFs.writeFileSync).not.toHaveBeenCalled();  // retained batch 未重 dump
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[AUDIT WARNING\] fallback fsync recovered: .*entries=1 attempts=1$/),
    );

    // 后续新 batch 正常 durable
    writer.write('second_batch_event', 'col2');
    const next = writer.dispose();
    expect(next?.kind).toBe('durable');
    const secondDump = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    expect(secondDump).toContain('second_batch_event');
    expect(secondDump).not.toContain('first_batch_event');
  });

  it('fsync bounded retry 耗尽 → failed_retained：CRITICAL 留证、不再自动重试、不重复 dump', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncErr = Object.assign(new Error('fsync EIO'), { code: 'EIO' });
    vi.mocked(nodeFs.fsyncSync).mockImplementation(() => { throw syncErr; });

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    writer.write('test_event', 'col1');

    expect(writer.dispose()?.kind).toBe('pending_retry');   // attempts=1
    expect(writer.dispose()?.kind).toBe('pending_retry');   // attempts=2
    const exhausted = writer.dispose();                     // attempts=3 ≥ MAX(3)
    expect(exhausted).toEqual({ kind: 'failed_retained', error: syncErr, entries: 1 });
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[AUDIT CRITICAL\] fallback fsync retries exhausted: .*durability unconfirmed; batch retained in memory/),
    );

    // 耗尽后：机会性重试仍保留证据、绝不重 dump
    vi.mocked(nodeFs.writeFileSync).mockClear();
    expect(writer.dispose()?.kind).toBe('failed_retained');
    expect(nodeFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('retry 时 dump 文件已被外部删除（ENOENT）→ entries 回 buffer 重 dump（原文件消失、非重复）', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncErr = Object.assign(new Error('fsync EIO'), { code: 'EIO' });
    vi.mocked(nodeFs.fsyncSync).mockImplementation(() => { throw syncErr; });

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    writer.write('test_event', 'col1');
    expect(writer.dispose()?.kind).toBe('pending_retry');

    // 文件消失：openSync ENOENT；fsync 恢复成功 → 重 dump 新文件
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(nodeFs.openSync).mockImplementation(() => { throw enoent; });
    vi.mocked(nodeFs.fsyncSync).mockImplementation(() => {});
    vi.mocked(nodeFs.writeFileSync).mockClear();

    const outcome = writer.dispose();
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[AUDIT CRITICAL\] fallback dump file vanished before durability confirm: .*entries restored to buffer for re-dump$/),
    );
    // vanished 分支 entries 回 buffer → 同次调用走正常 dump（writeFileSync openSync mock 仍 ENOENT…）
    // openSync 仍抛 ENOENT → 新 dump 的 fsync 也失败 → 再次 pending_retry（证明 entries 未丢）
    expect(outcome?.kind).toBe('pending_retry');
    expect(nodeFs.writeFileSync).toHaveBeenCalledTimes(1);
    const redump = (vi.mocked(nodeFs.writeFileSync).mock.calls[0] as any)[1] as string;
    expect(redump).toContain('test_event');
  });

  it('retention 期间新 drop 的 metadata 不丢：追认后下次 dump frontmatter 只记未核销 drop', () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncErr = Object.assign(new Error('fsync EIO'), { code: 'EIO' });

    const writer = new AuditWriter(makeFailingFs(), '/test/audit.tsv');
    // 第一批：overflow 1 drop（frontmatter 记 drop_count_since_last_dump=1）
    for (let i = 0; i < 1001; i++) writer.write('event', `first=${i}`);
    vi.mocked(nodeFs.fsyncSync).mockImplementation(() => { throw syncErr; });
    expect(writer.dispose()?.kind).toBe('pending_retry');

    // retention 期间第二批：再 overflow 1 drop（since=2 total=2）
    for (let i = 0; i < 1001; i++) writer.write('event', `second=${i}`);

    // fsync 恢复 → dispose：retry 追认（核销第一批已记录 1）→ 继续 dump 第二批
    vi.mocked(nodeFs.fsyncSync).mockImplementation(() => {});
    const outcome = writer.dispose();
    expect(outcome?.kind).toBe('durable');
    const secondDump = (vi.mocked(nodeFs.writeFileSync).mock.calls[1] as any)[1] as string;
    // frontmatter 只记未核销的 1 个 drop（第一批的 1 已随 retained dump 耐久确认核销）
    expect(secondDump).toContain('# drop_count_since_last_dump=1 drop_count_total=2');
    expect(secondDump).toContain('second=');
    expect(secondDump).not.toContain('first=');
  });
});
