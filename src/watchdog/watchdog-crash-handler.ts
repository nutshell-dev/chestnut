/**
 * @module L6.Watchdog.CrashHandler
 * @layer L6 进程边界（Watchdog 守护进程）
 *
 * Watchdog 进程级 crash handler：
 * - 可捕获崩溃（uncaughtException / unhandledRejection）在退出前尽力写
 *   `crashed` terminal 并保留 `watchdog_crash` audit；
 * - SIGKILL/断电等不可捕获终止由下次 CLI 触发 recovery 时根据 stale active
 *   补记 `unclean` terminal。
 *
 * 本模块只注册 handler，不启动 loop，便于 entry 与测试分别使用。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import { getAuditWriter, getChestnutFs } from './watchdog-context.js';
import { recordGenerationTerminal } from './watchdog-ownership.js';
import { writeWatchdogCrash } from './watchdog-state.js';

const errMsg = (reason: unknown): string =>
  reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);

function recordCrashTerminal(
  fsFactory: (baseDir: string) => FileSystem,
  reason: unknown,
): void {
  try {
    const auditWriter = getAuditWriter();
    if (!auditWriter) return;
    const fs = getChestnutFs(fsFactory);
    const activeOwner = JSON.parse(fs.readSync('watchdog/active/owner.json')) as {
      attempt_id: string;
      owner_token: string;
      pid: number;
    };
    recordGenerationTerminal(
      fs,
      {
        attemptId: activeOwner.attempt_id,
        ownerToken: activeOwner.owner_token,
        pid: activeOwner.pid,
      },
      {
        kind: 'crashed',
        reason: errMsg(reason),
        recorded_at: new Date().toISOString(),
      },
    );
  } catch {
    // silent: crash handler 不可靠上下文，terminal 写失败由下次 recovery 兜底补 unclean
  }
}

export function registerWatchdogCrashHandlers(
  fsFactory: (baseDir: string) => FileSystem,
): void {
  process.on('uncaughtException', (err) => {
    try {
      recordCrashTerminal(fsFactory, err);
    } catch {
      // silent: terminal 为 best-effort，失败仍继续写 crash audit 并退出
    }
    try {
      writeWatchdogCrash(err);
    } catch (writeErr) {
      console.error('[watchdog] writeWatchdogCrash failed:', writeErr);
    }
    console.error('[watchdog] Uncaught exception:', err);
    // phase 538 (review-round4 follow-up): exit 前 dispose audit、与 daemon-entry 对称
    getAuditWriter()?.dispose?.();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    try {
      recordCrashTerminal(fsFactory, reason);
    } catch {
      // silent: terminal 为 best-effort，失败仍继续写 crash audit 并退出
    }
    try {
      writeWatchdogCrash(new Error(errMsg(reason)));
    } catch (writeErr) {
      console.error('[watchdog] writeWatchdogCrash failed:', writeErr);
    }
    console.error('[watchdog] Unhandled rejection:', reason);
    // phase 538 (review-round4 follow-up): exit 前 dispose audit
    getAuditWriter()?.dispose?.();
    process.exit(1);
  });
}
