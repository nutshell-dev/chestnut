import { NodeFileSystem } from '../foundation/fs/index.js';
import { constructShimAudit, registerShimHandlers } from './daemon-handlers.js';
import { createDaemonCommand } from './daemon.js';
import { assemble, createRootConfig } from '../assembly/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from '../assembly/index.js';
import { DAEMON_FILE_ROUTING, DAEMON_INBOX_MESSAGE_TYPES, DAEMON_AUDIT_EVENTS } from './index.js';
import type { AssembleConfig, Instances } from '../assembly/index.js';

// shim 早期注册（在 daemon command 调用之前；ESM imports hoist 与代码执行解耦）
const shimAudit = constructShimAudit(process.argv[2]);
// phase 1873 Step F/E: shim 让位句柄——内层 handler 就绪后经 deps 传回的 standDown 让位；
// 早退场景（内层未就绪）由下方 finally 终态收尾（幂等）。
const shimHandle = registerShimHandlers(shimAudit);

// phase 1247 Step D: daemon 不再持有 watchdog 探针；fsFactory 仅用于 daemon 自身文件系统。
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
  rootConfig: createRootConfig({ fsFactory }),
  assemble: assembleWithDaemonContributions,
  // phase 1873 Step F: 内层 graceful handler 就绪后让位（移除 shim 监听 + dispose shimAudit）。
  shimStandDown: () => shimHandle.standDown(),
  auditEvents: {
    // 装配失败（Assembly owner）与 Daemon 进程生命周期事件（Daemon owner）分离。
    assembleFailed: ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
    preRuntimeFailed: DAEMON_AUDIT_EVENTS.PRE_RUNTIME_FAILED,
    daemonStart: DAEMON_AUDIT_EVENTS.DAEMON_START,
    daemonCrash: DAEMON_AUDIT_EVENTS.DAEMON_CRASH,
  },
});

try {
  await daemonCommand(process.argv[2]);
} finally {
  // phase 1873 Step E: 早退场景（shim 未让位）→ entry 终态收尾（幂等；让位过的为 no-op）。
  shimHandle.standDown();
}
