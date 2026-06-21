/**
 * Process-manager factories — shared by CLI and Watchdog (L2).
 *
 * §1 所有权：
 *   - 职责：为 CLI 命令（非 daemon）提供 ProcessManager 的统一构造入口
 *   - 消费者：CLI 命令、Watchdog、其他 L2+ 非 daemon 装配场景
 *   - 非职责：不装配 Runtime / Snapshot / Stream 等 L2+ 对象（由 Assembly 负责）
 *
 * §5 隐式依赖：
 *   - getChestnutRoot()（config.ts）：createProcessManagerForCLI 的 PM / audit 根
 *   - NodeFileSystem 构造签名（foundation/fs）、AuditWriter 构造签名、createAgentProcessManager 签名
 *
 * §6 历史：
 *   - phase 1397: `createDirContext` 迁出至 `foundation/audit/dir-context.ts`
 *     （L2 audit 模块职责归属修正、不属 process-manager）。
 */

import { createSystemAudit } from '../audit/index.js';
import type { FileSystem } from '../fs/types.js';
import type { ProcessManager } from './manager.js';
import { createAgentProcessManager } from './agent-factory.js';
import { getChestnutRoot } from '../config/index.js';

/**
 * createProcessManagerForCLI
 *
 * 输入：
 *   - 无参数（内部固定 getChestnutRoot()）
 *
 * 输出：
 *   - ProcessManager 实例；每次调用返回新对象（无缓存、无单例）
 *   - PID / lockfile 根：chestnutRoot（不可配置，由 ProcessManager 内部决定）
 *   - audit 落盘：chestnutRoot/audit.tsv（跨 agent 的进程管理属 chestnut 层资源）
 *   - 回归原 createMotionPM 语义（phase154 定义）
 *
 * 边界：
 *   - 不 acquireLock；不写 audit；不校验目录存在性
 *   - OS-only（NodeFileSystem 0 PermissionChecker dep / phase430 caller 自治）
 *
 * 失败：
 *   - 构造失败（NodeFileSystem / createSystemAudit / createAgentProcessManager 任一抛错）→ 原样上抛
 *   - 不包装；调用方（CLI 命令）通常不 catch，让错误直接打印
 */
export function createProcessManagerForCLI(deps: { fsFactory: (baseDir: string) => FileSystem; motionClawId: string }): ProcessManager {
  const baseDir = getChestnutRoot();
  const fs = deps.fsFactory(baseDir);
  const systemAudit = createSystemAudit(fs, baseDir);
  return createAgentProcessManager(deps, systemAudit);
}
