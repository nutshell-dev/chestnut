import { NodeFileSystem } from './foundation/fs/node-fs.js';
import type { FileSystem } from './foundation/fs/index.js';
import { runWatchdogLoop, writeWatchdogCrash } from './watchdog/watchdog.js';
import { DAEMON_LOG } from './daemon/constants.js';
import { getAuditWriter } from './watchdog/watchdog-context.js';

const errMsg = (reason: unknown): string =>
  reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);

process.on('uncaughtException', (err) => {
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
    writeWatchdogCrash(new Error(errMsg(reason)));
  } catch (writeErr) {
    console.error('[watchdog] writeWatchdogCrash failed:', writeErr);
  }
  console.error('[watchdog] Unhandled rejection:', reason);
  // phase 538 (review-round4 follow-up): exit 前 dispose audit
  getAuditWriter()?.dispose?.();
  process.exit(1);
});

const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });

// phase 444 Step B DI：装配胶水承担 watchdog→daemon 协作连接、watchdog 模块不直 import daemon（M#5 单向）。
await runWatchdogLoop(fsFactory, DAEMON_LOG);
