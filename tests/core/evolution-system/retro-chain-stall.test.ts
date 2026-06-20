/**
 * Phase 450 (review-round3 §3): retroChain wait prev 超时反向测试。
 *
 * 验证：
 * - 正常 chain 串行（无 stall、无 STALLED audit）
 * - prev 永不 resolve → 超时后本次进 impl + emit RETRO_CHAIN_STALLED audit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import type { ContractId } from '../../../src/foundation/branded/contract-id.js';

const RETRO_CHAIN_STALL_TIMEOUT_MS = 10 * 60 * 1000;

describe('retroChain stall timeout (phase 450 review)', () => {
  let testDir: string;
  let clawDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-retro-chain-stall-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'motion');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeSystem(): EvolutionSystem {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    return new EvolutionSystem({
      fs: nodeFs,
      audit: { write: auditWrite, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as never,
      taskSystem: {} as never,
      contractManager: {} as never,
    });
  }

  it('正常 chain 串行 — 无 STALLED audit', async () => {
    const sys = makeSystem();
    // 替换 _runRetroForContractImpl 为快速返回 mock
    const impl = vi.fn().mockResolvedValue({ status: 'finished' } as never);
    (sys as unknown as { _runRetroForContractImpl: typeof impl })._runRetroForContractImpl = impl;

    const r1 = await sys.runRetroForContract('c-1' as ContractId, {} as never);
    const r2 = await sys.runRetroForContract('c-2' as ContractId, {} as never);

    expect(r1.status).toBe('finished');
    expect(r2.status).toBe('finished');
    expect(impl).toHaveBeenCalledTimes(2);

    const stallCalls = auditWrite.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.RETRO_CHAIN_STALLED);
    expect(stallCalls).toHaveLength(0);
  });

  it('prev 永不 resolve → 超时后本次进 impl + emit RETRO_CHAIN_STALLED', async () => {
    vi.useFakeTimers();
    const sys = makeSystem();

    // 第一次 impl 永不 resolve
    let resolveFirst: (() => void) | null = null;
    const neverPromise = new Promise<{ status: 'finished' }>(res => {
      resolveFirst = () => res({ status: 'finished' });
    });
    const impl = vi.fn()
      .mockImplementationOnce(() => neverPromise)
      .mockResolvedValueOnce({ status: 'finished' } as never);
    (sys as unknown as { _runRetroForContractImpl: typeof impl })._runRetroForContractImpl = impl;

    // 第一次 runRetroForContract — 不 await（卡在 impl）
    void sys.runRetroForContract('c-1' as ContractId, {} as never);
    // 推时间让 microtask flush
    await Promise.resolve();

    // 第二次 runRetroForContract — 应等 prev、但 prev 永不 resolve → 等 stall timeout
    const p2 = sys.runRetroForContract('c-2' as ContractId, {} as never);

    // 推进 stall timeout
    await vi.advanceTimersByTimeAsync(RETRO_CHAIN_STALL_TIMEOUT_MS + 100);

    const r2 = await p2;
    expect(r2.status).toBe('finished');
    expect(impl).toHaveBeenCalledTimes(2);  // 第二次 impl 跑了

    const stallCalls = auditWrite.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.RETRO_CHAIN_STALLED);
    expect(stallCalls).toHaveLength(1);
    expect(stallCalls[0]).toContainEqual('contract_id=c-2');
    expect(stallCalls[0]).toContainEqual(`timeout_ms=${RETRO_CHAIN_STALL_TIMEOUT_MS}`);

    // cleanup: 解锁第一个 retro
    resolveFirst?.();
  });
});
