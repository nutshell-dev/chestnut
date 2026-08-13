/**
 * phase 1383 (P2b U3): waiting-stall in-process 自活监测单元测试。
 *
 * 覆盖：
 *   - active 契约 + 等待超时 → WAITING_STALL_DETECTED + self-inbox 写入 + eventLoop.abort 调用
 *   - 无 active 契约的 idle → 不触发
 *   - 活动打点（noteActivity）重置等待计时，不触发
 *   - 连续 N 次自愈无效 → ESCALATED
 *   - 自愈后观察到活动 → SELF_HEALED + 计数归零
 *   - stop() 清理定时器、不再触发
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsNative from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { startWaitingStallMonitor } from '../../src/daemon/waiting-stall.js';
import { DAEMON_AUDIT_EVENTS } from '../../src/daemon/audit-events.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';
import {
  WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS,
} from '../../src/daemon/constants.js';

function createMockAudit(): AuditLog & { entries: [string, ...(string | number)[]][] } {
  const entries: [string, ...(string | number)[]][] = [];
  return {
    entries,
    write: (type: string, ...cols: (string | number)[]) => {
      entries.push([type, ...cols]);
    },
  };
}

describe('waiting-stall self-heal monitor (phase 1383)', () => {
  let agentDir: string;
  let inboxPendingDir: string;
  let activeDir: string;
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    agentDir = path.join(os.tmpdir(), `waiting-stall-test-${randomUUID()}`);
    fsNative.mkdirSync(agentDir, { recursive: true });
    inboxPendingDir = path.join(agentDir, 'inbox', 'pending');
    fsNative.mkdirSync(inboxPendingDir, { recursive: true });
    activeDir = path.join(agentDir, 'contract', 'active');
    fsNative.mkdirSync(activeDir, { recursive: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fsNative.rmSync(agentDir, { recursive: true, force: true });
  });

  function makeActiveContract(id = '1700000000000-abc123'): void {
    fsNative.mkdirSync(path.join(activeDir, id), { recursive: true });
  }

  function listInboxFiles(): string[] {
    return fsNative.readdirSync(inboxPendingDir).filter(f => f.endsWith('.md'));
  }

  it('active 契约 + 等待超时 → DETECTED + self-inbox + abort', () => {
    makeActiveContract();
    const audit = createMockAudit();
    const abort = vi.fn();
    const CHECK_MS = 1000;
    const STALL_MS = 5000;

    startWaitingStallMonitor({
      fsFactory,
      agentDir,
      audit,
      eventLoop: { abort },
      checkIntervalMs: CHECK_MS,
      stallTimeoutMs: STALL_MS,
    });

    // 未到阈值：不触发
    vi.advanceTimersByTime(STALL_MS - 1);
    expect(abort).not.toHaveBeenCalled();
    expect(audit.entries.some(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED)).toBe(false);

    // 越过阈值：触发一次自愈
    vi.advanceTimersByTime(2);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(audit.entries.some(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED)).toBe(true);
    // self-inbox 写入一条 high-priority 消息
    const files = listInboxFiles();
    expect(files.length).toBe(1);
    const content = fsNative.readFileSync(path.join(inboxPendingDir, files[0]), 'utf-8');
    expect(content).toContain('waiting_stall_self_heal');
  });

  it('无 active 契约的 idle → 不触发', () => {
    const audit = createMockAudit();
    const abort = vi.fn();
    const CHECK_MS = 1000;
    const STALL_MS = 5000;

    startWaitingStallMonitor({
      fsFactory,
      agentDir,
      audit,
      eventLoop: { abort },
      checkIntervalMs: CHECK_MS,
      stallTimeoutMs: STALL_MS,
    });

    vi.advanceTimersByTime(STALL_MS * 3);
    expect(abort).not.toHaveBeenCalled();
    expect(listInboxFiles().length).toBe(0);
    expect(audit.entries.some(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED)).toBe(false);
  });

  it('noteActivity 重置等待计时 → 不触发', () => {
    makeActiveContract();
    const audit = createMockAudit();
    const abort = vi.fn();
    const CHECK_MS = 1000;
    const STALL_MS = 5000;

    const monitor = startWaitingStallMonitor({
      fsFactory,
      agentDir,
      audit,
      eventLoop: { abort },
      checkIntervalMs: CHECK_MS,
      stallTimeoutMs: STALL_MS,
    });

    // 每个 check 周期打点活动
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(CHECK_MS);
      monitor.noteActivity();
    }
    expect(abort).not.toHaveBeenCalled();
    expect(audit.entries.some(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED)).toBe(false);
  });

  it(`连续 ${WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS} 次自愈无效 → ESCALATED`, () => {
    makeActiveContract();
    const audit = createMockAudit();
    const abort = vi.fn();
    const CHECK_MS = 1000;
    const STALL_MS = 5000;

    startWaitingStallMonitor({
      fsFactory,
      agentDir,
      audit,
      eventLoop: { abort },
      checkIntervalMs: CHECK_MS,
      stallTimeoutMs: STALL_MS,
    });

    // check 节拍 = CHECK_MS：前 STALL_MS/CHECK_MS-1 个节拍 idle<阈值不触发；
    // 之后每个节拍 attempt+1，连续 N 次达 ESCALATED（N-1 次 DETECTED + 1 次 ESCALATED）。
    vi.advanceTimersByTime(STALL_MS + (WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS - 1) * CHECK_MS);

    expect(audit.entries.filter(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED).length)
      .toBe(WAITING_STALL_MAX_SELF_HEAL_ATTEMPTS - 1);
    expect(audit.entries.some(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_ESCALATED)).toBe(true);
  });

  it('自愈后观察到活动 → SELF_HEALED 且计数归零', () => {
    makeActiveContract();
    const audit = createMockAudit();
    const abort = vi.fn();
    const CHECK_MS = 1000;
    const STALL_MS = 5000;

    const monitor = startWaitingStallMonitor({
      fsFactory,
      agentDir,
      audit,
      eventLoop: { abort },
      checkIntervalMs: CHECK_MS,
      stallTimeoutMs: STALL_MS,
    });

    // 触发一次 detect
    vi.advanceTimersByTime(STALL_MS);
    expect(audit.entries.some(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_DETECTED)).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);

    // 自愈生效：活动恢复 → SELF_HEALED
    monitor.noteActivity();
    expect(audit.entries.some(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_SELF_HEALED)).toBe(true);

    // 再等一个阈值，计数从 1 开始（只再触发 1 次 detect，不到 escalated 阈值 3）
    vi.advanceTimersByTime(STALL_MS);
    expect(abort).toHaveBeenCalledTimes(2);
    expect(audit.entries.filter(e => e[0] === DAEMON_AUDIT_EVENTS.WAITING_STALL_ESCALATED).length).toBe(0);
  });

  it('stop() 后不再触发', () => {
    makeActiveContract();
    const audit = createMockAudit();
    const abort = vi.fn();
    const CHECK_MS = 1000;
    const STALL_MS = 5000;

    const monitor = startWaitingStallMonitor({
      fsFactory,
      agentDir,
      audit,
      eventLoop: { abort },
      checkIntervalMs: CHECK_MS,
      stallTimeoutMs: STALL_MS,
    });

    monitor.stop();
    vi.advanceTimersByTime(STALL_MS * 3);
    expect(abort).not.toHaveBeenCalled();
    expect(listInboxFiles().length).toBe(0);
  });
});
