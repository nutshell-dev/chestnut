/**
 * phase 1765: AuditWriter 主 append 路径 durability outcome 测试。
 *
 * 冻结设计（Phase 1764）：
 * - append + sync 成功 → durable；
 * - sync 失败 → committed_platform_limited（原始 error/path/row identity），
 *   不得伪装成功、不得重复 append、不得进 fallback（reconcile 会双份）；
 * - append 失败 → pending_fallback（row 进 fallback 池，证据保留）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AuditWriter, _resetFallbackForTest } from '../../../src/foundation/audit/writer.js';
import { DispatchingAuditWriter } from '../../../src/foundation/audit/dispatching-writer.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

const FILE_PATH = '/fake/base/audit.tsv';

function makeFakeFs(opts: { appendSyncThrows?: Error; syncSyncThrows?: Error } = {}) {
  const appended: Array<{ path: string; line: string }> = [];
  const fake = {
    appendSync: vi.fn((p: string, line: string) => {
      if (opts.appendSyncThrows) throw opts.appendSyncThrows;
      appended.push({ path: p, line });
    }),
    syncSync: vi.fn((_p: string) => {
      if (opts.syncSyncThrows) throw opts.syncSyncThrows;
    }),
  };
  return { fs: fake as unknown as FileSystem, appended, appendSync: fake.appendSync, syncSync: fake.syncSync };
}

describe('AuditWriter durability outcome（phase 1765）', () => {
  afterEach(() => {
    _resetFallbackForTest();
    vi.restoreAllMocks();
  });

  it('append + sync 成功返回 durable', () => {
    const { fs, appendSync, syncSync } = makeFakeFs();
    const writer = new AuditWriter(fs, FILE_PATH);

    const outcome = writer.write('test_event', 'k=v');

    expect(outcome).toEqual({ kind: 'durable' });
    expect(appendSync).toHaveBeenCalledTimes(1);
    expect(syncSync).toHaveBeenCalledTimes(1);
    expect(appendSync.mock.calls[0][1]).toContain('test_event');
  });

  it('sync 失败返回 committed_platform_limited：原始 error/path/row identity 保留，且不重复 append、不进 fallback', () => {
    const syncErr = Object.assign(new Error('fsync EIO'), { code: 'EIO' });
    const { fs, appendSync, syncSync } = makeFakeFs({ syncSyncThrows: syncErr });
    const writer = new AuditWriter(fs, FILE_PATH);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = writer.write('test_event', 'k=v');

    expect(outcome.kind).toBe('committed_platform_limited');
    if (outcome.kind === 'committed_platform_limited') {
      expect(outcome.path).toBe(FILE_PATH);
      expect(outcome.error).toBe(syncErr); // 原始 error 对象无损
      expect(outcome.row).toContain('test_event');
      expect(outcome.row).toContain('seq=1');
      expect(outcome.row.endsWith('\n')).toBe(true);
    }
    // 不重复 append（append 仅一次）；不进 fallback 池（下一次写 seq 仍 +1、无回放双份）
    expect(appendSync).toHaveBeenCalledTimes(1);
    expect(syncSync).toHaveBeenCalledTimes(1);
    writer.write('next_event');
    expect(appendSync).toHaveBeenCalledTimes(2);
    expect(appendSync.mock.calls[1][1]).toContain('seq=2');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[AUDIT WARNING] sync failed'));
  });

  it('sync 失败仍返回结构化 outcome（非仅 warning 后正常返回）——warning 只是并行观测通道', () => {
    const { fs } = makeFakeFs({ syncSyncThrows: new Error('fsync EPERM') });
    const writer = new AuditWriter(fs, FILE_PATH);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = writer.write('evt');
    expect(outcome.kind).not.toBe('durable');
    expect(outcome.kind).toBe('committed_platform_limited');
  });

  it('append 失败返回 pending_fallback：row 进 fallback 池且证据保留', () => {
    const appendErr = Object.assign(new Error('append ENOSPC'), { code: 'ENOSPC' });
    const { fs, appendSync } = makeFakeFs({ appendSyncThrows: appendErr });
    const writer = new AuditWriter(fs, FILE_PATH);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = writer.write('test_event', 'k=v');

    expect(outcome.kind).toBe('pending_fallback');
    if (outcome.kind === 'pending_fallback') {
      expect(outcome.path).toBe(FILE_PATH);
      expect(outcome.error).toBe(appendErr);
      expect(outcome.row).toContain('test_event');
      expect(outcome.row).toContain('seq=1');
    }
    expect(appendSync).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[AUDIT CRITICAL] write failed'));
    // fallback 池证据：dispose dump 含该行（tmpdir dump + drop frontmatter 通道）
  });

  it('row identity 含 trace_id（设置 traceId 时）', () => {
    const { fs } = makeFakeFs({ syncSyncThrows: new Error('fsync EIO') });
    const writer = new AuditWriter(fs, FILE_PATH);
    writer.traceId = '7b922f1afc4859e5' as import('../../../src/foundation/audit/types.js').TraceId;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = writer.write('traced_event');
    expect(outcome.kind).toBe('committed_platform_limited');
    if (outcome.kind === 'committed_platform_limited') {
      expect(outcome.row).toContain('trace_id=7b922f1afc4859e5');
      expect(outcome.row).toContain('traced_event');
    }
  });

  it('DispatchingAuditWriter 透传路由 writer 的 outcome（sync 失败携带目标文件 path）', () => {
    const syncErr = new Error('fsync EIO');
    const appended: Array<{ path: string; line: string }> = [];
    const fake = {
      appendSync: vi.fn((p: string, line: string) => {
        appended.push({ path: p, line });
      }),
      syncSync: vi.fn((p: string) => {
        if (p.endsWith('tick.tsv')) throw syncErr;
      }),
    };
    const fs = fake as unknown as FileSystem;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const writer = new DispatchingAuditWriter(
      fs,
      '/fake/base',
      new Map([['tick_event', 'tick']]),
    );

    const tickOutcome = writer.write('tick_event', 'k=v');
    expect(tickOutcome.kind).toBe('committed_platform_limited');
    if (tickOutcome.kind === 'committed_platform_limited') {
      expect(tickOutcome.path).toBe('/fake/base/tick.tsv');
      expect(tickOutcome.error).toBe(syncErr);
      expect(tickOutcome.row).toContain('tick_event');
    }

    const auditOutcome = writer.write('other_event', 'k=v');
    expect(auditOutcome).toEqual({ kind: 'durable' });
  });
});
