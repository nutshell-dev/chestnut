import { NodeFileSystem } from '../foundation/fs/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { runWatchdogLoop } from './watchdog.js';
import { getAuditWriter } from './watchdog-context.js';
import { registerWatchdogCrashHandlers } from './watchdog-crash-handler.js';

const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });

registerWatchdogCrashHandlers(fsFactory);

// Phase 1464 Step B: daemon spawn specification（含 DAEMON_LOG 路径协议）归 Daemon 唯一 owner，
// watchdog 不再经装配 DI 接收 daemonLogName（phase 444 DI 退役）。
await runWatchdogLoop(fsFactory);
// phase 1203 Step B: ownership loser 在任何副作用前 return → 立即 dispose audit 并退出（early outcome/exit）
getAuditWriter()?.dispose?.();
