import { NodeFileSystem } from '../foundation/fs/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { createSystemAudit, type AuditLog } from '../foundation/audit/index.js';
import { getClawDir, getNamedSubrootDir } from '../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';
import { DAEMON_AUDIT_EVENTS } from './index.js';

// shim 层：daemon-entry 启动早期的 audit sink + process handler 注册。
// 与 daemon.ts 内层 handler 形成双层兜底（详 design/modules/l6_daemon.md §1）。
// phase 375 从 daemon-entry.ts 抽出 — 让 daemon-entry.test 不再拉 assembly graph (transit 30s+ hookTimeout debt)。

const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });

const errMsg = (reason: unknown): string =>
  reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);

/**
 * 构造 shim audit sink（daemon-entry 启动早期、daemon.ts 未入时兜底）。
 * argv 解析失败 / fs 构造失败 → 返 null（handler 走 fallback console）。
 *
 * Phase 1200: argv schema validate（防 OWASP-level injection、'.', '..', '/', '\\', '\x00-\x1f'）
 */
export function constructShimAudit(rawName: unknown): AuditLog | null {
  try {
    if (typeof rawName !== 'string' || rawName === '' || rawName === '.' || rawName.startsWith('.') || rawName.includes('/') || rawName.includes('\\') || /[\x00-\x1f]/.test(rawName) || rawName.includes('..')) {
      throw new Error(`Invalid daemon argv[2]: ${JSON.stringify(rawName)}`);
    }
    const dir = rawName === MOTION_CLAW_ID ? getNamedSubrootDir('motion') : getClawDir(rawName);
    const shimFs: FileSystem = fsFactory(dir);
    return createSystemAudit(shimFs, dir);
  } catch {
    return null;  // audit sink 构造失败 → handler fallback console
  }
}

/** phase 1873 Step F: shim 让位句柄（幂等；让位时释放 shimAudit）。 */
export interface ShimHandle {
  /** 内层 graceful handler 就绪后让位：移除 shim 监听（未捕获错误转交内层）+ dispose shimAudit。 */
  standDown(): void;
}

/**
 * 注册 process-level uncaughtException + unhandledRejection handler。
 * 双层兜底（shim 层）：只在内层 handler 尚不可用时兜底——audit emit + console +
 * exit(1)；内层就绪后由 daemon 调 standDown() 让位（phase 1873 Step F：
 * harsh shim exit 不截断内层 graceful teardown）。
 * audit 写入失败 → silent fallback console（last-resort、不可再 audit 自身）。
 */
export function registerShimHandlers(shimAudit: AuditLog | null): ShimHandle {
  const onUnhandledRejection = (reason: unknown): void => {
    const msg = errMsg(reason);
    try {
      shimAudit?.write(DAEMON_AUDIT_EVENTS.UNHANDLED_REJECTION, `error=${msg}`);
    } catch { /* audit 写入失败静默、fallback console 保运维可见 */ }
    console.error('[daemon] Unhandled rejection:', reason);
    // phase 518 (review-round4 CLI M、phase 477 gap 补完): shim handler 同 inner
    // daemon handler 加 dispose、flush batched audit buffer 防 telemetry 丢
    shimAudit?.dispose?.();
    process.exit(1);
  };

  const onUncaughtException = (err: unknown): void => {
    const msg = errMsg(err);
    try {
      shimAudit?.write(DAEMON_AUDIT_EVENTS.UNCAUGHT_EXCEPTION, `error=${msg}`);
    } catch { /* silent: audit-down 时 fallback console 保运维可见 / 已是 last-resort fallback / 不可再 audit 自身 */ }
    console.error('[daemon] Uncaught exception:', err);
    // phase 518 (review-round4 CLI M、phase 477 gap 补完): shim handler dispose
    shimAudit?.dispose?.();
    process.exit(1);
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  let stoodDown = false;
  return {
    standDown(): void {
      if (stoodDown) return;
      stoodDown = true;
      process.removeListener('unhandledRejection', onUnhandledRejection);
      process.removeListener('uncaughtException', onUncaughtException);
      // phase 1873 Step E 协调：让位 = shim 职责段结束 → dispose shimAudit（flush）。
      shimAudit?.dispose?.();
    },
  };
}
