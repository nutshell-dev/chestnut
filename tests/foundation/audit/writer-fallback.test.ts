import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import * as nodeOs from 'node:os';
import * as nodeFsPromises from 'node:fs/promises';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

// phase 1788: reconcile 测试隔离 —— getFallbackDir()=tmpdir() 走本 mock，
// drop event failure 用例重定向到独立目录，避免共享 tmpdir 跨测试文件竞态。
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
import type { AuditFailureReporter } from '../../../src/foundation/audit/writer.js';
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

/**
 * Phase 1788: `audit_fallback_dropped` 事件的 append/sync 失败不得空 catch 吞掉 ——
 * 进入受限 AuditFailureReporter secondary channel（保留原始 error + drop metadata），
 * reporter 自身抛错只允许最后一道同步 console 边界，不递归 audit、不上抛。
 *
 * 隔离：tmpdir mock 重定向到 per-describe 独立目录，与并行测试文件零共享。
 */
describe('reconcileFallbackDumps — drop event failure observability (phase 1788)', () => {
  let dumpDir: string;
  let dumpSeq = 0;

  beforeEach(async () => {
    dumpDir = await nodeFsPromises.mkdtemp(`${realTmpdir()}/chestnut-drop-evt-1788-`);
    mockTmpdir.mockImplementation(() => dumpDir);
  });

  afterEach(async () => {
    mockTmpdir.mockImplementation(() => realTmpdir());
    try { await nodeFsPromises.rm(dumpDir, { recursive: true, force: true }); } catch { /* silent: test cleanup */ }
    vi.restoreAllMocks();
  });

  async function writeDump(lines: string[]): Promise<string> {
    const p = `${dumpDir}/chestnut-audit-fallback-${process.pid}-${Date.now() * 100 + (dumpSeq++)}.tsv`;
    await nodeFsPromises.writeFile(p, lines.join('\n') + '\n');
    return p;
  }

  const FRONTMATTER = '# drop_count_since_last_dump=2 drop_count_total=5 first_drop_ts=100 last_drop_ts=200';
  const VALID_LINE = '/test/a.tsv\t2026-09-07T10:00:00.000Z\tevt_a\tcol1';

  /** appendSync：主回放成功；drop event 行（audit_fallback_dropped 前缀）按 opts 失败。 */
  function makeDropFailingFs(boom: Error, opts: { failOn: 'append' | 'sync' }): FileSystem {
    let mainSynced = false;
    return {
      appendSync: vi.fn((origin: string, content: string) => {
        if (opts.failOn === 'append' && content.startsWith('audit_fallback_dropped\t')) throw boom;
      }),
      syncSync: vi.fn(() => {
        if (opts.failOn === 'sync') {
          if (!mainSynced) { mainSynced = true; return; }  // 主回放 sync 成功
          throw boom;                                      // drop event sync 失败
        }
      }),
    } as any;
  }

  it('drop event append 失败 → reporter 收到 typed failure（kind/error/entries），主回放不受影响', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeDump([FRONTMATTER, VALID_LINE]);
    const boom = new Error('EIO drop event append');
    const reporter = vi.fn() as unknown as AuditFailureReporter;

    const result = await reconcileFallbackDumps(makeDropFailingFs(boom, { failOn: 'append' }), reporter);

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith({
      kind: 'drop_event_write_failed',
      error: boom,
      entries: 2,  // dropMeta.since
    });
    // 主回放成功 + drop 事件失败不改 retention：dump 正常删除
    expect(result.ok).toBe(true);
    expect(nodeFs.existsSync(`${dumpDir}`)).toBe(true);
  });

  it('drop event sync 失败 → 同样进 reporter（原 fsync best-effort 空 catch 已治理）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeDump([FRONTMATTER, VALID_LINE]);
    const boom = new Error('EIO drop event fsync');
    const reporter = vi.fn() as unknown as AuditFailureReporter;

    await reconcileFallbackDumps(makeDropFailingFs(boom, { failOn: 'sync' }), reporter);

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith({
      kind: 'drop_event_write_failed',
      error: boom,
      entries: 2,
    });
  });

  it('默认 channel = console 边界：未注入 reporter 时 console.error 留痕且不递归 audit', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeDump([FRONTMATTER, VALID_LINE]);
    const boom = new Error('EIO default channel');

    await reconcileFallbackDumps(makeDropFailingFs(boom, { failOn: 'append' }));

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[AUDIT WARNING\] audit fallback drop event write failed: kind=drop_event_write_failed entries=2 reason=.*EIO default channel/),
    );
  });

  it('reporter 自身抛错 → 最后一道 console 边界保留原 failure，reconcile 不上抛', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeDump([FRONTMATTER, VALID_LINE]);
    const boom = new Error('EIO drop event append');
    const reporterBoom = new Error('reporter crashed');
    const reporter: AuditFailureReporter = () => { throw reporterBoom; };

    await expect(
      reconcileFallbackDumps(makeDropFailingFs(boom, { failOn: 'append' }), reporter),
    ).resolves.toBeDefined();

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[AUDIT WARNING\] audit failure reporter threw: reason=.*reporter crashed.*original failure: kind=drop_event_write_failed entries=2 reason=.*EIO drop event append/),
    );
  });

  it('drop event 正常写入 → 零 reporter 调用（对照）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dumpPath = await writeDump([FRONTMATTER, VALID_LINE]);
    const appended: string[] = [];
    const mockFs = {
      appendSync: vi.fn((origin: string, content: string) => { appended.push(content); }),
      syncSync: vi.fn(),
    } as any;
    const reporter = vi.fn() as unknown as AuditFailureReporter;

    const result = await reconcileFallbackDumps(mockFs, reporter);

    expect(reporter).not.toHaveBeenCalled();
    // drop event 行正常回放进 origin 文件
    expect(appended.some(c => c.startsWith('audit_fallback_dropped\t') && c.includes('drop_count=2'))).toBe(true);
    expect(result.ok).toBe(true);
    expect(nodeFs.existsSync(dumpPath)).toBe(false);
  });
});
