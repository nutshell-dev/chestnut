import { NodeFileSystem } from '../foundation/fs/index.js';
import { constructShimAudit, registerShimHandlers } from './daemon-handlers.js';
import { createDaemonCommand } from './index.js';
import { assemble, disassemble } from '../assembly/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from '../assembly/index.js';
import { isWatchdogAlive } from '../watchdog/watchdog-pid.js';
import { DAEMON_FILE_ROUTING, DAEMON_INBOX_MESSAGE_TYPES } from './index.js';
import type { AssembleConfig } from '../assembly/types.js';
import type { Instances } from '../assembly/types.js';

// shim 早期注册（在 daemon command 调用之前；ESM imports hoist 与代码执行解耦）
const shimAudit = constructShimAudit(process.argv[2]);
registerShimHandlers(shimAudit);

// phase 444: fsFactory 提到 closure 内、watchdogAliveProbe 与 createDaemonCommand 共享同一 instance。
const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

// phase 1243 Step B: daemon-entry 作为 Daemon lifecycle 的 glue，将 Daemon-owned declarations
// 作为通用数据传给 Assembly，删除 Assembly→Daemon 的 production import。
async function assembleWithDaemonContributions(config: AssembleConfig): Promise<Instances> {
  return assemble(config, {
    auditFileRouting: [DAEMON_FILE_ROUTING],
    inboxMessageTypes: [...DAEMON_INBOX_MESSAGE_TYPES],
  });
}

const daemonCommand = createDaemonCommand({
  fsFactory,
  assemble: assembleWithDaemonContributions,
  disassemble,
  auditEvents: {
    assembleFailed: ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
    daemonStart: ASSEMBLY_AUDIT_EVENTS.DAEMON_START,
    daemonCrash: ASSEMBLY_AUDIT_EVENTS.DAEMON_CRASH,
  },
  // phase 444 DI：装配胶水承担 daemon→watchdog 协作连接、daemon 模块不直 import watchdog（M#5 单向）。
  watchdogAliveProbe: () => isWatchdogAlive(fsFactory),
});

await daemonCommand(process.argv[2]);
