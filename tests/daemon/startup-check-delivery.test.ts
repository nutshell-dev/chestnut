/**
 * Phase 1838: startup check delivery outcome（真实消息记录确认）。
 *
 * - timestamp 写失败 → pending_retry{stage:'timestamp'}，恢复后下 tick 重试成功
 * - 查询未知（pre/post）→ pending_retry{stage:'notify'}，含 op 与本次 startup_check_ts；
 *   不盲发、不误 fired、不清除时间戳
 * - 查询命中（含上轮写盘后抛错）→ 不重复投递直接 fired
 * - confirm 后 firedOutcome 缓存：重复调用不再查询、不再发送
 * - not_eligible 保留原 once-per-process 语义
 *
 * 本文件用模块 mock 细分分支；真实 FS/Messaging 端到端证据见
 * startup-check-real-delivery.test.ts。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockShouldEmit = vi.hoisted(() => vi.fn());
vi.mock('../../src/daemon/startup-check.js', () => ({
  shouldEmitStartupCheck: mockShouldEmit,
}));

const mockNotifyInbox = vi.hoisted(() => vi.fn());
const mockFindByExtraMeta = vi.hoisted(() => vi.fn());
vi.mock('../../src/foundation/messaging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/messaging/index.js')>();
  return {
    ...actual,
    notifyInbox: mockNotifyInbox,
    createInboxReader: vi.fn(() => ({ findByExtraMeta: mockFindByExtraMeta })),
  };
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

const HIT = { file: 'daemon-1_high_x.md', location: 'pending' as const };

describe('startup-check delivery — phase 1838 real-record confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldEmit.mockReturnValue(true);
    mockFindByExtraMeta.mockResolvedValue(null); // 默认 absent
  });

  it('timestamp 写失败 → pending_retry{stage:timestamp}；恢复后下 tick 重写并 fired', async () => {
    const { fs, writeAtomicSync } = makeAgentFs();
    writeAtomicSync.mockImplementationOnce(() => { throw new Error('EIO disk full'); });
    const delivery = createStartupCheckDelivery(makeDeps(fs));

    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'timestamp' });
    expect((first as { error: string }).error).toContain('EIO disk full');
    expect(writeAtomicSync).toHaveBeenCalledTimes(1);
    expect(mockNotifyInbox).not.toHaveBeenCalled();
    expect(mockFindByExtraMeta).not.toHaveBeenCalled();

    // 重试仍走完整 eligibility + 重写 timestamp；notify 后 post-query 命中
    mockFindByExtraMeta.mockResolvedValueOnce(null).mockResolvedValueOnce(HIT);
    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    expect(mockShouldEmit).toHaveBeenCalledTimes(2);
    expect(writeAtomicSync).toHaveBeenCalledTimes(2);
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1);
    const writtenTs = Number(writeAtomicSync.mock.calls[1]![1]);
    expect((second as { timestampMs: number }).timestampMs).toBe(writtenTs);
    // metadata 关联值 = 本次已提交 timestamp
    expect(mockNotifyInbox.mock.calls[0]![1].metadata).toEqual({ startup_check_ts: String(writtenTs) });
    // 查询参数：关联键/值 + done Infinity 窗口
    expect(mockFindByExtraMeta).toHaveBeenCalledWith(
      'startup_check_ts', String(writtenTs), { includeDoneWithinMs: Number.POSITIVE_INFINITY },
    );
  });

  it('pre-query 未知 → pending_retry 含 op/ts、不盲发；恢复后命中确认、不重写 timestamp', async () => {
    const { fs, writeAtomicSync } = makeAgentFs();
    const delivery = createStartupCheckDelivery(makeDeps(fs));

    mockFindByExtraMeta.mockRejectedValueOnce(new Error('EIO list'));
    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'notify' });
    const writtenTs = Number(writeAtomicSync.mock.calls[0]![1]);
    expect((first as { error: string }).error).toContain('op=pre-query');
    expect((first as { error: string }).error).toContain(`startup_check_ts=${writtenTs}`);
    expect((first as { error: string }).error).toContain('EIO list');
    expect(mockNotifyInbox).not.toHaveBeenCalled();

    // 次轮：bypass eligibility、不重写 timestamp；pre-query 命中 → 不重复 notify 直接 fired
    mockFindByExtraMeta.mockResolvedValueOnce(HIT);
    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    expect(mockShouldEmit).toHaveBeenCalledTimes(1);
    expect(writeAtomicSync).toHaveBeenCalledTimes(1);
    expect(mockNotifyInbox).not.toHaveBeenCalled();
  });

  it('post-query 未知 → pending_retry 而非 fired；恢复后确认、不重复写', async () => {
    const { fs, writeAtomicSync } = makeAgentFs();
    const delivery = createStartupCheckDelivery(makeDeps(fs));

    mockFindByExtraMeta.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('EIO read'));
    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'notify' });
    expect((first as { error: string }).error).toContain('op=post-query');
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1);

    mockFindByExtraMeta.mockResolvedValueOnce(HIT);
    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1); // 不重复写
    expect(writeAtomicSync).toHaveBeenCalledTimes(1);
  });

  it('notify 后 post-query 仍缺席 → pending_retry{stage:notify}；下 tick 不重写 timestamp、只重试 notify', async () => {
    const { fs, writeAtomicSync } = makeAgentFs();
    const delivery = createStartupCheckDelivery(makeDeps(fs));

    mockFindByExtraMeta.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const first = await delivery.deliver();
    expect(first).toMatchObject({ kind: 'pending_retry', stage: 'notify' });
    expect((first as { error: string }).error).toContain('absent after notifyInbox');
    expect(writeAtomicSync).toHaveBeenCalledTimes(1);
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1);

    mockFindByExtraMeta.mockResolvedValueOnce(null).mockResolvedValueOnce(HIT);
    const second = await delivery.deliver();
    expect(second.kind).toBe('fired');
    expect(mockShouldEmit).toHaveBeenCalledTimes(1); // 不再重评估
    expect(writeAtomicSync).toHaveBeenCalledTimes(1); // 不重写 timestamp（cooldown 基线不漂移）
    expect(mockNotifyInbox).toHaveBeenCalledTimes(2);
  });

  it('confirm 后重复 deliver 返回同一 fired：不再查询、不再发送', async () => {
    const { fs } = makeAgentFs();
    const delivery = createStartupCheckDelivery(makeDeps(fs));

    mockFindByExtraMeta.mockResolvedValueOnce(null).mockResolvedValueOnce(HIT);
    const first = await delivery.deliver();
    expect(first.kind).toBe('fired');

    const second = await delivery.deliver();
    expect(second).toBe(first); // 进程内派生缓存，同一 fired outcome
    expect(mockFindByExtraMeta).toHaveBeenCalledTimes(2); // 仅首轮 pre/post
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1);
  });

  it('not_eligible 不投递不写盘；成功路径单发 fired', async () => {
    const { fs: fsIneligible, writeAtomicSync: writeIneligible } = makeAgentFs();
    mockShouldEmit.mockReturnValueOnce(false);
    const ineligible = createStartupCheckDelivery(makeDeps(fsIneligible));
    expect(await ineligible.deliver()).toEqual({ kind: 'not_eligible' });
    expect(writeIneligible).not.toHaveBeenCalled();
    expect(mockNotifyInbox).not.toHaveBeenCalled();

    const { fs, writeAtomicSync } = makeAgentFs();
    const delivery = createStartupCheckDelivery(makeDeps(fs));
    mockFindByExtraMeta.mockResolvedValueOnce(null).mockResolvedValueOnce(HIT);
    const outcome = await delivery.deliver();
    expect(outcome.kind).toBe('fired');
    expect(writeAtomicSync).toHaveBeenCalledTimes(1);
    expect(mockNotifyInbox).toHaveBeenCalledTimes(1);
  });
});
