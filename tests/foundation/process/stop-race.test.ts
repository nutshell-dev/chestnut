/**
 * stop.ts race + getAliveStatus probe single responsibility (phase 879)
 *
 * 反向 3 项：
 * 1. probe 不删 pidfile (new4.P2.1-C M#1)
 * 2. stop 直读 l1IsAlive、不走 isAliveByPidFile race window (new4.P1.1)
 * 3. l1IsAlive(pid) 直读不受并发 pidfile 删除影响 (race window 消除)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { getAliveStatus } from '../../../src/foundation/process-manager/alive.js';
import { stopProcess } from '../../../src/foundation/process-manager/stop.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { DEAD_PID } from '../../helpers/dead-pid.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

// Mock constants to eliminate sleep delays
vi.mock('../../../src/foundation/process-manager/constants.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DAEMON_SHUTDOWN_GRACE_MS: 0 };
});

// Mock process-exec so no real signal is sent and isAlive is controllable
vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn().mockReturnValue(false),
    kill: vi.fn(),
  };
});

describe('stop.ts race + getAliveStatus probe single responsibility (phase 879)', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    tempDir = path.join(tmpdir(), `stop-race-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx(audit: ProcessManagerContext['audit']): ProcessManagerContext {
    return {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };
  }

  it('probe 不删 pidfile (new4.P2.1-C M#1)', async () => {
    const clawId = 'probe-no-delete';
    const statusDir = path.join(tempDir, 'claws', clawId, 'status');
    await fs.mkdir(statusDir, { recursive: true });
    const pidFile = path.join(statusDir, 'pid');
    await fs.writeFile(pidFile, String(DEAD_PID), 'utf-8');

    const ctx = makeCtx(makeAudit().audit);
    const result = getAliveStatus(ctx, clawId);

    expect(result.alive).toBe(false);
    expect(result.reason).toMatch(/not alive/i);
    // M#1：probe 不 mutate state、pidfile 仍存
    const stillExists = await fs.access(pidFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(true);
  });

  it('stop 直读 l1IsAlive、不走 isAliveByPidFile race window (new4.P1.1)', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    const mockedIsAlive = vi.mocked(isAlive);
    // 第 1 次 l1IsAlive 检（STALE 分支前）→ true（进程 alive）
    // 第 2 次 l1IsAlive 检（SIGTERM grace 后）→ true（进程仍 alive）→ 触发 SIGKILL escalation
    mockedIsAlive.mockReturnValueOnce(true).mockReturnValueOnce(true);

    const { audit, events } = makeAudit();
    const clawId = 'stop-l1-direct';
    const statusDir = path.join(tempDir, 'claws', clawId, 'status');
    await fs.mkdir(statusDir, { recursive: true });
    const pidFile = path.join(statusDir, 'pid');
    const fakeLivePid = 12345;
    await fs.writeFile(pidFile, String(fakeLivePid), 'utf-8');

    const ctx = makeCtx(audit);
    const result = await stopProcess(ctx, clawId);

    expect(result).toBe(true);
    // 不应走 STALE 分支（进程是 alive 的）
    const staleEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_STALE,
    );
    expect(staleEvents).toHaveLength(0);
    // 应发 KILL_ESCALATED（因为 mock 返回 alive、SIGTERM 后仍 alive）+ STOPPED
    const killEscalatedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_KILL_ESCALATED,
    );
    expect(killEscalatedEvents).toHaveLength(1);
    const stoppedEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOPPED,
    );
    expect(stoppedEvents).toHaveLength(1);
  });

  it('l1IsAlive(pid) 直读不受并发 pidfile 删除影响 (race window 消除)', async () => {
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    const mockedIsAlive = vi.mocked(isAlive);
    mockedIsAlive.mockReturnValue(false);

    const { audit, events } = makeAudit();
    const clawId = 'stop-race-immune';
    const statusDir = path.join(tempDir, 'claws', clawId, 'status');
    await fs.mkdir(statusDir, { recursive: true });
    const pidFile = path.join(statusDir, 'pid');
    await fs.writeFile(pidFile, String(DEAD_PID), 'utf-8');

    const ctx = makeCtx(audit);

    // 模拟并发 caller 在 readPid 之后删了 pidfile
    // 由于 stop 用 l1IsAlive(pid) 直读、不依赖 pidfile，决策不受影响
    const originalRead = nodeFs.read.bind(nodeFs);
    vi.spyOn(nodeFs, 'read').mockImplementation(async (p: string) => {
      const result = await originalRead(p);
      if (p.endsWith('/pid')) {
        // readPid 成功后立即删 pidfile，模拟并发 race
        await fs.unlink(p).catch(() => {});
      }
      return result;
    });

    const result = await stopProcess(ctx, clawId);

    expect(result).toBe(true);
    // 应走 STALE 分支（因为 l1IsAlive(DEAD_PID)=false）
    const staleEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_STALE,
    );
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_STOP_STALE,
        `claw=${clawId}`,
        `pid=${DEAD_PID}`,
      ]),
    );
  });
});
