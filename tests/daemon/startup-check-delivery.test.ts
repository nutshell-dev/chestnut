/**
 * Phase 1794: startup check typed delivery outcome（两阶段提交）。
 *
 * - timestamp 写失败 → pending_retry{stage:'timestamp'}，恢复后下 tick 重试成功
 * - notifyInbox 不抛出（owner best-effort barrier）→ 以 dedup identity post-condition
 *   核实投递；pending 缺席 → pending_retry{stage:'notify'}，下 tick 不重写 timestamp
 * - 上轮 notify 写盘后抛错（dedup 命中）→ 不重复投递直接 fired
 * - not_eligible 保留原 once-per-process 语义
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockShouldEmit = vi.hoisted(() => vi.fn());
const mockHasPending = vi.hoisted(() => vi.fn());
vi.mock('../../src/daemon/startup-check.js', () => ({
  shouldEmitStartupCheck: mockShouldEmit,
  hasPendingStartupCheck: mockHasPending,
}));

const mockNotifyInbox = vi.hoisted(() => vi.fn());
vi.mock('../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/messaging/index.js')>();
  return { ...actual, notifyInbox: mockNotifyInbox };
});

import { createStartupCheckDelivery } from '../../src/daemon/daemon-loop.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';

function makeAgentFs(): {
  fs: FileSystem;
  ensureDirSync: ReturnType<typeof vi.fn>;
  writeAtomicSync: ReturnType<typeof vi.fn>;
} {
  const ensureDirSync = vi.fn();
  const writeAtomicSync = vi.fn();
  return { fs: { ensureDirSync, writeAtomicSync } as unknown as FileSystem, ensureDirSync, writeAtomicSync };
}

function makeDeps(agentFs: FileSystem) {
  return {
    agentFs,
    clawFs: {} as FileSystem,
    agentDir: '/agent',
    audit: { write: vi.fn() } as any,
  };
}

describe('startup-check delivery — phase 1794 two-phase commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldEmit.mockReturnValue(true);
    mockHasPending.mockReturnValue(false);
  });

  it('timestamp 写失败 → pending_retry{stage:timestamp}；恢复后下 tick 重写并 fired', () => {
    const { fs, writeAtomicSync } = makeAgentFs();
    writeAtomicSync.mockImplementationOnce(() => { throw new Error('EIO disk full'); });
    const delivery = createStartupCheckDelivery(makeDeps(fs));

    const first = delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'timestamp' });
    expect((first as { error: string }).error).toContain('EIO disk full');
    expect(writeAtomicSync).toHaveBeenCalledTimes(1);
    expect(mockNotifyInbox).not.toHaveBeenCalled();

    // 重试仍走完整 eligibility + 重写 timestamp；notify 后 dedup post-condition 命中
    mockHasPending.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const second = delivery.deliver();
    expect(second.kind).toBe('fired');
    // timestamp 失败未提交 → 重试仍走完整 eligibility + 重写 timestamp
    expect(mockShouldEmit).toHaveBeenCalledTimes(2);
    expect(writeAtomicSync).toHaveBeenCalledTimes(2);
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1);
    // fired 携带持久化的 timestampMs
    const writtenTs = Number(writeAtomicSync.mock.calls[1]![1]);
    expect((second as { timestampMs: number }).timestampMs).toBe(writtenTs);
  });

  it('notify 未投递（dedup post-condition 缺席）→ pending_retry{stage:notify}；下 tick 不重写 timestamp、只重试 notify', () => {
    const { fs, writeAtomicSync } = makeAgentFs();
    const delivery = createStartupCheckDelivery(makeDeps(fs));

    // 首轮：pre-notify 缺席 → notify → post-notify 仍缺席（未投递）
    mockHasPending.mockReturnValueOnce(false).mockReturnValueOnce(false);
    const first = delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'notify' });
    expect(writeAtomicSync).toHaveBeenCalledTimes(1);
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1);

    // 次轮：bypass eligibility 重评估（startup_check_ts 刚提交、cooldown 必未过），
    // 不重写 timestamp；pre 缺席 → 重试 notify → post 命中 → fired
    mockHasPending.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const second = delivery.deliver();
    expect(second.kind).toBe('fired');
    expect(mockShouldEmit).toHaveBeenCalledTimes(1); // 不再重评估
    expect(writeAtomicSync).toHaveBeenCalledTimes(1); // 不重写 timestamp（cooldown 基线不漂移）
    expect(mockNotifyInbox).toHaveBeenCalledTimes(2);
  });

  it('上轮 notify 写盘后抛错（dedup identity 命中）→ 不重复投递直接 fired', () => {
    const { fs } = makeAgentFs();
    const delivery = createStartupCheckDelivery(makeDeps(fs));

    // 首轮：post-condition 缺席（notifyInbox 内部已吞错并 audit）
    mockHasPending.mockReturnValueOnce(false).mockReturnValueOnce(false);
    expect(delivery.deliver()).toMatchObject({ kind: 'pending_retry', stage: 'notify' });

    // 次轮：pending 已存在（上轮实际已写盘）→ dedup 命中，不重复 notify
    mockHasPending.mockReturnValueOnce(true);
    const second = delivery.deliver();
    expect(second.kind).toBe('fired');
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1); // 不重复投递
  });

  it('not_eligible 不投递不写盘；成功路径单发 fired', () => {
    const { fs: fsIneligible, writeAtomicSync: writeIneligible } = makeAgentFs();
    mockShouldEmit.mockReturnValueOnce(false);
    const ineligible = createStartupCheckDelivery(makeDeps(fsIneligible));
    expect(ineligible.deliver()).toEqual({ kind: 'not_eligible' });
    expect(writeIneligible).not.toHaveBeenCalled();
    expect(mockNotifyInbox).not.toHaveBeenCalled();

    const { fs, writeAtomicSync } = makeAgentFs();
    const delivery = createStartupCheckDelivery(makeDeps(fs));
    mockHasPending.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const outcome = delivery.deliver();
    expect(outcome.kind).toBe('fired');
    expect(writeAtomicSync).toHaveBeenCalledTimes(1);
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1);
  });
});
