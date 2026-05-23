/**
 * ready marker — isReady / markReady / markNotReady (phase 1114)
 *
 * 验证点：
 * 1. markReady → isReady true → markNotReady → isReady false
 * 2. 反向 1：mark 写完不 delete → isReady 持 true
 * 3. 反向 2：corrupt JSON → isReady false
 * 4. 反向 3：stale marker (PID mismatch) → isReady false + READY_MARK_STALE audit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { markReady, markNotReady, isReady } from '../../../src/foundation/process-manager/ready.js';
import { makeAudit } from '../../helpers/audit.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../../../src/foundation/process-manager/audit-events.js';
import { FAKE_LIVE_PID, FAKE_LIVE_PID_STRING } from '../../helpers/test-pids.js';
import type { ProcessManagerContext } from '../../../src/foundation/process-manager/types.js';

vi.mock('../../../src/foundation/process-exec/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/process-exec/index.js')>();
  return {
    ...actual,
    isAlive: vi.fn().mockReturnValue(true),
  };
});

describe('isReady / markReady / markNotReady', () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    vi.restoreAllMocks();
    const { isAlive } = await import('../../../src/foundation/process-exec/index.js');
    vi.mocked(isAlive).mockReturnValue(true);

    tempDir = path.join(tmpdir(), `ready-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeCtx(): ProcessManagerContext {
    const { audit } = makeAudit();
    return {
      fs: nodeFs,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };
  }

  async function writePidFile(clawId: string, pid: number): Promise<void> {
    const pidFile = path.join(tempDir, 'claws', clawId, 'status', 'pid');
    await fs.mkdir(path.dirname(pidFile), { recursive: true });
    await fs.writeFile(pidFile, JSON.stringify({ pid }), 'utf-8');
  }

  it('markReady → isReady true → markNotReady → isReady false', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    await writePidFile(clawId, process.pid);

    expect(isReady(ctx, clawId)).toBe(false);

    await markReady(ctx, clawId);
    expect(isReady(ctx, clawId)).toBe(true);

    await markNotReady(ctx, clawId);
    expect(isReady(ctx, clawId)).toBe(false);
  });

  it('反向 1：mark 写完不 delete → isReady 持 true', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    await writePidFile(clawId, process.pid);

    await markReady(ctx, clawId);
    expect(isReady(ctx, clawId)).toBe(true);

    // 不调用 markNotReady，isReady 仍应为 true
    expect(isReady(ctx, clawId)).toBe(true);
  });

  it('反向 2：corrupt JSON → isReady false', async () => {
    const ctx = makeCtx();
    const clawId = 'test-claw';
    await writePidFile(clawId, process.pid);

    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, 'not-json', 'utf-8');

    expect(isReady(ctx, clawId)).toBe(false);
  });

  it('反向 3：stale marker (PID mismatch) → isReady false + READY_MARK_STALE audit', async () => {
    const { audit, events } = makeAudit();
    const clawId = 'test-claw';
    const nodeFsLocal = new NodeFileSystem({ baseDir: tempDir });
    const ctx: ProcessManagerContext = {
      fs: nodeFsLocal,
      audit,
      resolveDir: (id: string) => path.join(tempDir, 'claws', id),
    };

    // pidFile 写当前进程 PID
    await writePidFile(clawId, process.pid);

    // ready marker 写不同的 PID（模拟 stale）
    const readyFile = path.join(tempDir, 'claws', clawId, 'status', 'ready');
    await fs.mkdir(path.dirname(readyFile), { recursive: true });
    await fs.writeFile(readyFile, JSON.stringify({ pid: FAKE_LIVE_PID }), 'utf-8');

    expect(isReady(ctx, clawId)).toBe(false);

    const staleEvents = events.filter(
      (e) => e[0] === PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
    );
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]).toEqual(
      expect.arrayContaining([
        PROCESS_MANAGER_AUDIT_EVENTS.READY_MARK_STALE,
        expect.stringContaining('claw='),
        expect.stringContaining(`ready_pid=${FAKE_LIVE_PID}`),
        expect.stringContaining(`pid_file_pid=${process.pid}`),
      ]),
    );
  });
});
