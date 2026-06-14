/**
 * Daemon liveness monitor — PID file unlink event 驱动替 setInterval polling.
 *
 * viewport 监听 daemon PID file 的 'unlink' 事件、daemon shutdown 时清理 PID
 * 即触发 onDead. 替原 setInterval(checkDaemonAlive, 3000ms) 走事件驱动路径。
 *
 * daemon SIGKILL 不清 PID 的情形由 watchdog 已有 stale PID 清理逻辑覆盖（会触 unlink）.
 *
 * Per 项目设计原则「事件驱动、避免预灌上下文」.
 */

import { createWatcher, type Watcher } from '../../foundation/file-watcher/index.js';

export interface DaemonLivenessMonitorDeps {
  pidFilePath: string;        // abs path to daemon PID file
  onDead: () => void;         // caller: 标 daemonDead + abort + display + observability
  onError?: (err: Error) => void;  // watcher 内部错误
}

/**
 * Create file watcher that triggers onDead when PID file 被 unlink.
 *
 * stability='immediate' 因 daemon shutdown 是 latency-sensitive UX、要立刻显示.
 *
 * Returns Watcher; caller responsible for close() in cleanup path.
 */
export function createDaemonLivenessMonitor(deps: DaemonLivenessMonitorDeps): Watcher {
  return createWatcher(
    deps.pidFilePath,
    (event) => {
      if (event.type === 'unlink') {
        deps.onDead();
      }
    },
    {
      stability: 'immediate',
      persistent: false,
      onError: (err) => deps.onError?.(err),
    },
  );
}
