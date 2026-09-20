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
 *
 * phase 1280：兼具 bootstrap 与业务语义的复合命令（`start`）不走 required，
 * 改用 cliDeferredRequiredAction——不在 handler 前 ensure，而是注入一次性
 * ensure capability，由 handler 在 workspace bootstrap 落盘后调用。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { ensureWatchdog, isWatchdogAlive } from '../watchdog/index.js';
import { withCliErrorHandling } from './with-cli-error-handling.js';
import { createCliActionScope, setCurrentActionScope } from './action-scope.js';

export type SupervisionPolicy =
  | 'required'
  | 'observe_only'
  | 'disabled'
  | 'internal';

interface SupervisionContext {
  fsFactory: (baseDir: string) => FileSystem;
}

/**
 * phase 1874 Step I: 每次 action 一个 resource scope（handler 内经 actionAuditFor 复用/注册，
 * 成功路径统一 dispose）。错误路径 dispose 由 Step H 在同一 finally 接入。
 * CLIProcess 每次 invoke 独立进程 → 模块级 current scope 语义充分。
 */
async function runWithActionScope(ctx: SupervisionContext, fn: () => Promise<void>): Promise<void> {
  const scope = createCliActionScope({ fsFactory: ctx.fsFactory });
  setCurrentActionScope(scope);
  let ok = false;
  try {
    await fn();
    ok = true;
  } finally {
    setCurrentActionScope(null);
    if (ok) await scope.disposeAll('completed');
  }
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
    await runWithActionScope(ctx, async () => {
      await executePolicy(policy, ctx);
      await handler(...args);
    });
  });
}

/**
 * 一次性监督 capability（phase 1280）：由 CLI 监督边界创建并注入 deferred
 * action；handler 在自身 bootstrap 完整落盘后、业务副作用前调用。
 * 只暴露 `ensure(): Promise<void>`，不暴露 fsFactory 或 Watchdog 内部对象。
 */
export type EnsureSupervision = () => Promise<void>;

/**
 * 注册一个 deferred-required CLI action（如 `start`：先 bootstrap workspace，
 * 再恢复 Watchdog，最后才允许业务副作用）。
 *
 * 与 cliAction('required', ...) 的区别仅在于 ensure 的时机交给 handler；
 * capability 每次调用都委托既有 ensureWatchdog(fsFactory)，普通 required 语义不变。
 * 返回函数同样带 withCliErrorHandling 边界。
 */
export function cliDeferredRequiredAction<TArgs extends unknown[]>(
  handler: (ensureSupervision: EnsureSupervision, ...args: TArgs) => Promise<void>,
  ctx: SupervisionContext,
): (...args: TArgs) => Promise<void> {
  return withCliErrorHandling((...args) =>
    runWithActionScope(ctx, () => handler(() => ensureWatchdog(ctx.fsFactory), ...args)));
}
