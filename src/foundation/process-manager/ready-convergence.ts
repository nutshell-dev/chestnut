/**
 * @module L2a.ProcessManager.ReadyConvergence
 * Ready convergence 等待原语（Phase 1282 Step C）。
 *
 * ProcessManager 内部唯一拥有 ready convergence 的调度骨架：
 *   - BOOT_DEADLINE_MS 起止与 timeout 判定（deadline 判定唯一持有点；
 *     数值定义归 constants.ts，phase 1303 迁出使测试可经 constants mock 缩短）；
 *   - SPAWN_POLL_INTERVAL_MS 轮询调度（唯一 poll 循环持有点）；
 *   - pending / ready / failed 收敛骨架。
 *
 * self-winner（spawn）与 foreign-winner（ensureRunning join）只提供各自的
 * 磁盘事实观察器与终局解释（错误类型、cleanup、audit 均留在调用方），
 * 不得再各自维护 deadline/poll 循环。
 *
 * owner 内部原语：不从 index.ts 导出、不接受 poll interval / deadline 参数
 * （避免扩大耦合表面、防止第二套时限策略）。
 */

import { BOOT_DEADLINE_MS, SPAWN_POLL_INTERVAL_MS } from './constants.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 每轮观察结果：
 * - pending：事实未齐，继续等待（合法窗口，如 PID/ready 事实稍后到达）
 * - ready：  收敛成功，携带调用方终局值
 * - failed： 调用方判定的终局失败（保留各自 typed error / 消息）
 */
export type ConvergenceObservation<T> =
  | { kind: 'pending' }
  | { kind: 'ready'; value: T }
  | { kind: 'failed'; error: Error };

/**
 * 等待观察器收敛到 ready。
 *
 * 每轮顺序：observe → ready/failed 立即返回/抛出 → deadline 判定 → sleep。
 * 观察器抛出的异常（如 fail-closed 的 ProcessGenerationStateError）不经包装
 * 直接传播。timeout 错误由调用方工厂提供，保留各自上下文；deadline 数值与
 * 触发位置唯一属本原语。
 */
export async function awaitReadyConvergence<T>(
  observe: () => ConvergenceObservation<T> | Promise<ConvergenceObservation<T>>,
  makeTimeoutError: () => Error,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const observation = await observe();
    if (observation.kind === 'ready') return observation.value;
    if (observation.kind === 'failed') throw observation.error;
    if (Date.now() - start > BOOT_DEADLINE_MS) throw makeTimeoutError();
    await sleep(SPAWN_POLL_INTERVAL_MS);
  }
}
