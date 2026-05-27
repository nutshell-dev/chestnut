import { NodeFileSystem } from './foundation/fs/node-fs.js';
import type { FileSystem } from './foundation/fs/types.js';
import { runWatchdogLoop, writeWatchdogCrash } from './watchdog/watchdog.js';

const errMsg = (reason: unknown): string =>
  reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);

process.on('uncaughtException', (err) => {
  try {
    writeWatchdogCrash(err);
  } catch (writeErr) {
    console.error('[watchdog] writeWatchdogCrash failed:', writeErr);
  }
  console.error('[watchdog] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  try {
    writeWatchdogCrash(new Error(errMsg(reason)));
  } catch (writeErr) {
    console.error('[watchdog] writeWatchdogCrash failed:', writeErr);
  }
  console.error('[watchdog] Unhandled rejection:', reason);
  process.exit(1);
});

const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });

await runWatchdogLoop(fsFactory);
