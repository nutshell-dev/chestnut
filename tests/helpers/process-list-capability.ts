/**
 * phase 1883: process-list capability contract（l1_process_exec.md §9 #2 收口）
 *
 * real-OS 进程表查询（pgrep）在 macOS 高负载/瞬时 sysmon 故障下会 exit 3，
 * L1 如实抛 ProcessListUnavailable（行为正确）。本 helper 把「进程表查询可用」
 * 表达为测试的显式环境前提：
 *
 * - preflight 探针成功 → capability 在，0 impact 返回；
 * - 探针抛 ProcessListUnavailable（pgrep 缺失 / EPERM / sysmon 瞬时故障等
 *   环境侧不可用）→ `ctx.skip(原因)` typed skip——结果如实标 skipped
 *   （vitest ctx.skip 抛 PendingError 中断执行），不 catch 假绿、不静默通过；
 * - 其他错误原样抛出（不吞未知错误）；
 * - preflight 通过之后用例体内再遇 ProcessListUnavailable → 不经本 helper、
 *   照常 fail（真 flaky/真故障暴露，判定分层硬约束）。
 *
 * PM 侧协调：l2_process_manager §7.A `spawn-tests-ambient-pgrep-dependence`
 * 与本面同环境依赖；本 helper 放 tests/helpers/ 供其后续治理复用。
 */

import type { TestContext } from 'vitest';
import { findByPattern, ProcessListUnavailable } from '../../src/foundation/process-exec/index.js';

/** 探针形态：默认经 L1 自身 API 做一次真实进程表查询（'node' 在本仓测试环境必存在）。 */
export type ProcessListProbe = () => unknown;

export function requireProcessListCapability(
  ctx: Pick<TestContext, 'skip'>,
  probe: ProcessListProbe = () => findByPattern('node'),
): void {
  try {
    probe();
  } catch (err) {
    if (err instanceof ProcessListUnavailable) {
      const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
      ctx.skip(`process-list capability unavailable: ${cause}`);
      return; // ctx.skip 实然抛 PendingError 中断；此行防御旧语义不打断时继续执行
    }
    throw err;
  }
}
