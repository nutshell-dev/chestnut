/**
 * @module L6.CLI.SupervisionPolicy
 * @layer L6 CLI 外部入口
 *
 * 统一 CLI action 监督策略门：每个真实外部 action 显式声明 policy，
 * 由唯一 helper 在业务 handler 前执行 Watchdog 检查/恢复。
 *
 * Policy 语义（冻结）：
 * - required:      已初始化工作区的普通业务 action，action 前调用 ensureWatchdog
 * - observe_only:  纯状态/审计查询，读取存活状态但不启动
 * - disabled:      init / stop 等命令，不恢复 Watchdog
 * - internal:      daemon / watchdog 子进程入口，禁止递归 ensure
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { isWatchdogAlive } from '../watchdog/watchdog-pid.js';
import { ensureWatchdog } from '../watchdog/ensure.js';
import { withCliErrorHandling } from './with-cli-error-handling.js';

export type SupervisionPolicy =
  | 'required'
  | 'observe_only'
  | 'disabled'
  | 'internal';

export interface SupervisionContext {
  fsFactory: (baseDir: string) => FileSystem;
}

async function executePolicy(
  policy: SupervisionPolicy,
  ctx: SupervisionContext,
): Promise<void> {
  switch (policy) {
    case 'required':
      await ensureWatchdog(ctx.fsFactory);
      return;
    case 'observe_only': {
      // 读取存活状态但不启动；foreign workspace 等异常上抛给 withCliErrorHandling
      isWatchdogAlive(ctx.fsFactory);
      return;
    }
    case 'disabled':
    case 'internal':
      return;
    default: {
      const _exhaustive: never = policy;
      throw new Error(`unknown supervision policy: ${_exhaustive}`);
    }
  }
}

/**
 * 注册一个显式声明监督策略的 CLI action。
 * 返回的函数已包含 withCliErrorHandling 边界：先执行 policy，再进入 handler。
 */
export function cliAction<TArgs extends unknown[]>(
  policy: SupervisionPolicy,
  handler: (...args: TArgs) => Promise<void>,
  ctx: SupervisionContext,
): (...args: TArgs) => Promise<void> {
  return withCliErrorHandling(async (...args) => {
    await executePolicy(policy, ctx);
    await handler(...args);
  });
}
