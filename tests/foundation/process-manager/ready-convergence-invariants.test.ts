/**
 * Ready convergence 原语 invariants — Phase 1282 Step C：
 *  - 等待调度骨架（deadline/poll/收敛分支）唯一归 ready-convergence.ts：
 *    spawn.ts 与 ensure-running.ts 不得再持有 while 循环或 SPAWN_POLL_INTERVAL_MS，
 *    必须消费 awaitReadyConvergence；
 *  - 原语行为：ready 返回值、failed 传播调用方 typed error、observer 异常不包装、
 *    pending 由共享 BOOT_DEADLINE_MS 终止并调用调用方 timeout 工厂。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { BOOT_DEADLINE_MS } from '../../../src/foundation/process-manager/constants.js';
import {
  awaitReadyConvergence,
  type ConvergenceObservation,
} from '../../../src/foundation/process-manager/ready-convergence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PM_DIR = path.resolve(__dirname, '../../../src/foundation/process-manager');

describe('ready convergence wait primitive (phase 1282 Step C)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ready observation returns the caller value', async () => {
    const value = await awaitReadyConvergence(
      () => ({ kind: 'ready', value: 42 }),
      () => new Error('should not timeout'),
    );
    expect(value).toBe(42);
  });

  it('failed observation propagates the caller error as-is', async () => {
    const callerError = new Error('caller terminal');
    const err = await awaitReadyConvergence(
      () => ({ kind: 'failed', error: callerError }),
      () => new Error('should not timeout'),
    ).catch((e) => e);
    expect(err).toBe(callerError);
  });

  it('observer exception propagates without wrapping', async () => {
    const boom = new Error('observer boom');
    const err = await awaitReadyConvergence(
      () => { throw boom; },
      () => new Error('should not timeout'),
    ).catch((e) => e);
    expect(err).toBe(boom);
  });

  it('pending is terminated by the shared BOOT_DEADLINE_MS via the caller timeout factory', async () => {
    vi.useFakeTimers();
    const timeoutError = new Error('caller timeout context');
    const makeTimeoutError = vi.fn(() => timeoutError);
    let observations = 0;
    const promise = awaitReadyConvergence(
      (): ConvergenceObservation<number> => {
        observations++;
        return { kind: 'pending' };
      },
      makeTimeoutError,
    ).catch((e) => e);

    const ADVANCE_PAST_DEADLINE_MS = BOOT_DEADLINE_MS + 1000; // 略超 deadline，保证 timeout 触发
    await vi.advanceTimersByTimeAsync(ADVANCE_PAST_DEADLINE_MS);

    const err = await promise;
    expect(err).toBe(timeoutError);
    expect(makeTimeoutError).toHaveBeenCalledTimes(1);
    expect(observations).toBeGreaterThan(1); // 确实经过多轮 poll 而非立即失败
  });

  it('pending then ready converges without timeout', async () => {
    vi.useFakeTimers();
    let observations = 0;
    const promise = awaitReadyConvergence(
      (): ConvergenceObservation<string> => {
        observations++;
        return observations >= 3
          ? { kind: 'ready', value: 'done' }
          : { kind: 'pending' };
      },
      () => new Error('should not timeout'),
    );
    const ADVANCE_A_FEW_POLLS_MS = 500; // 覆盖数轮 poll（50ms 间隔）即可收敛
    await vi.advanceTimersByTimeAsync(ADVANCE_A_FEW_POLLS_MS);
    await expect(promise).resolves.toBe('done');
    expect(observations).toBe(3);
  });
});

describe('ready convergence single-owner architecture (phase 1282 Step C)', () => {
  const spawnSrc = fs.readFileSync(path.join(PM_DIR, 'spawn.ts'), 'utf-8');
  const ensureSrc = fs.readFileSync(path.join(PM_DIR, 'ensure-running.ts'), 'utf-8');
  const primitiveSrc = fs.readFileSync(path.join(PM_DIR, 'ready-convergence.ts'), 'utf-8');

  it('spawn.ts 与 ensure-running.ts 不再持有自己的 poll/deadline 循环', () => {
    for (const [name, src] of [['spawn.ts', spawnSrc], ['ensure-running.ts', ensureSrc]] as const) {
      expect(src, `${name} must not hold its own while loop`).not.toMatch(/\bwhile \(/);
      expect(src, `${name} must not poll directly`).not.toContain('SPAWN_POLL_INTERVAL_MS');
      expect(src, `${name} must not define its own deadline`).not.toMatch(/BOOT_DEADLINE_MS\s*=/);
    }
  });

  it('spawn.ts 与 ensure-running.ts 都消费共享原语 awaitReadyConvergence', () => {
    expect(spawnSrc).toContain("from './ready-convergence.js'");
    expect(spawnSrc).toContain('awaitReadyConvergence(');
    expect(ensureSrc).toContain("from './ready-convergence.js'");
    expect(ensureSrc).toContain('awaitReadyConvergence(');
  });

  it('deadline 数值唯一定义于 constants.ts 且不暴露等待参数', () => {
    // Phase 1303：数值定义自 ready-convergence.ts 迁入 constants.ts（跨模块导入
    // 绑定、可被测试 mock 覆盖）；判定持点仍在 ready-convergence.ts。
    const constantsSrc = fs.readFileSync(path.join(PM_DIR, 'constants.ts'), 'utf-8');
    expect(constantsSrc).toMatch(/export const BOOT_DEADLINE_MS = 30_000/);
    expect(primitiveSrc).not.toMatch(/BOOT_DEADLINE_MS\s*=/);
    expect(primitiveSrc).toContain("from './constants.js'");
    // 原语签名不接受 poll interval / deadline 参数（防第二套时限策略）
    const signature = primitiveSrc.slice(
      primitiveSrc.indexOf('export async function awaitReadyConvergence'),
      primitiveSrc.indexOf('): Promise<T>'),
    );
    expect(signature).not.toMatch(/deadlineMs|pollInterval|intervalMs/);
  });

  it('原语不从 barrel 导出（owner 内部能力）', () => {
    const indexSrc = fs.readFileSync(path.join(PM_DIR, 'index.ts'), 'utf-8');
    expect(indexSrc).not.toContain('ready-convergence');
    expect(indexSrc).not.toContain('awaitReadyConvergence');
  });
});
