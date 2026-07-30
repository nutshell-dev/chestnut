import { NodeFileSystem } from '../foundation/fs/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { runWatchdogLoop } from './watchdog.js';
import { DAEMON_LOG } from '../daemon/index.js';
import { getAuditWriter } from './watchdog-context.js';
import { registerWatchdogCrashHandlers } from './watchdog-crash-handler.js';

const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });

registerWatchdogCrashHandlers(fsFactory);

// phase 444 Step B DI：装配胶水承担 watchdog→daemon 协作连接、watchdog 模块不直 import daemon（M#5 单向）。
await runWatchdogLoop(fsFactory, DAEMON_LOG);
// phase 1203 Step B: ownership loser 在任何副作用前 return → 立即 dispose audit 并退出（early outcome/exit）
getAuditWriter()?.dispose?.();
