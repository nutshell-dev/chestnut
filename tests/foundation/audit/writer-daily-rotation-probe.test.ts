/**
 * Phase 1801: daily rotation typed probe —— 首行读取与 archive list 的非 ENOENT 故障
 * 不得折叠为 null/return（rotation/prune 静默停用）。
 *
 * - ENOENT → absent（正常缺失、静默）
 * - EACCES/EIO → failed：console CRITICAL 携带 stage/path/error，本轮 rotation/prune 跳过
 * - append 连续性：probe 失败不阻断当前 write
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditWriter } from '../../../src/foundation/audit/writer.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code });
}

interface ProbeFsOptions {
  readError?: NodeJS.ErrnoException;
  listError?: NodeJS.ErrnoException;
}

function makeProbeFs(opts: ProbeFsOptions = {}) {
  const spies = {
    readBytesSync: vi.fn((_p: string, _off: number, _len: number) => {
      if (opts.readError) throw opts.readError;
      return Buffer.from(`${new Date().toISOString()}\tseq=1\tevt\n`);
    }),
    listSync: vi.fn((_dir: string) => {
      if (opts.listError) throw opts.listError;
      return [];
    }),
    appendSync: vi.fn(async () => {}),
    syncSync: vi.fn(),
    moveSync: vi.fn(),
    deleteSync: vi.fn(),
  };
  return { fs: spies as unknown as FileSystem, spies };
}

describe('AuditWriter daily rotation probe (phase 1801)', () => {
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ENOENT 首行读取 → absent：静默、append 正常、不归档', () => {
    const { fs, spies } = makeProbeFs({ readError: errno('ENOENT') });
    const writer = new AuditWriter(fs, '/audit/tick.tsv', null, 30);

    writer.write('daemon_liveness_heartbeat', 'seq=a');

    expect(spies.appendSync).toHaveBeenCalledTimes(1);
    expect(spies.moveSync).not.toHaveBeenCalled();
    expect(consoleErrSpy).not.toHaveBeenCalled();
  });

  it('EACCES 首行读取 → failed{stage:read_first_line}：CRITICAL 证据 + 跳过本轮 rotation、append 不受阻', () => {
    const { fs, spies } = makeProbeFs({ readError: errno('EACCES') });
    const writer = new AuditWriter(fs, '/audit/tick.tsv', null, 30);

    writer.write('daemon_liveness_heartbeat', 'seq=a');

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[AUDIT CRITICAL\] daily rotation probe failed: stage=read_first_line path=\/audit\/tick\.tsv reason=.*EACCES/),
    );
    expect(spies.moveSync).not.toHaveBeenCalled();
    expect(spies.listSync).not.toHaveBeenCalled(); // probe 失败 → 本轮 prune 也跳过
    expect(spies.appendSync).toHaveBeenCalledTimes(1); // append 连续性
  });

  it('EACCES archive list → failed{stage:list_archives}：CRITICAL 证据 + prune 跳过、append 不受阻', () => {
    const { fs, spies } = makeProbeFs({ listError: errno('EACCES') });
    const writer = new AuditWriter(fs, '/audit/tick.tsv', null, 30);

    writer.write('daemon_liveness_heartbeat', 'seq=a');

    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[AUDIT CRITICAL\] daily rotation probe failed: stage=list_archives path=\/audit reason=.*EACCES/),
    );
    expect(spies.deleteSync).not.toHaveBeenCalled();
    expect(spies.appendSync).toHaveBeenCalledTimes(1);
  });

  it('ENOENT archive list → 目录缺席静默跳过（无 CRITICAL、append 正常）', () => {
    const { fs, spies } = makeProbeFs({ listError: errno('ENOENT') });
    const writer = new AuditWriter(fs, '/audit/tick.tsv', null, 30);

    writer.write('daemon_liveness_heartbeat', 'seq=a');

    expect(consoleErrSpy).not.toHaveBeenCalled();
    expect(spies.deleteSync).not.toHaveBeenCalled();
    expect(spies.appendSync).toHaveBeenCalledTimes(1);
  });

  it('正常路径回归：首行昨日日期 → 归档 moveSync 照常（typed probe 不改变成功语义）', () => {
    const { fs, spies } = makeProbeFs();
    spies.readBytesSync.mockReturnValue(Buffer.from('2026-08-06T23:59:50.000Z\tseq=1\tevt\n'));
    const writer = new AuditWriter(fs, '/audit/tick.tsv', null, 30);

    writer.write('daemon_liveness_heartbeat', 'seq=a');

    expect(spies.moveSync).toHaveBeenCalledWith('/audit/tick.tsv', '/audit/tick.20260806.tsv');
    expect(spies.appendSync).toHaveBeenCalledTimes(1);
    expect(consoleErrSpy).not.toHaveBeenCalled();
  });
});
