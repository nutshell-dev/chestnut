import { NodeFileSystem } from '../foundation/fs/index.js';
import { constructShimAudit, registerShimHandlers } from './daemon-handlers.js';
import { createDaemonCommand } from './daemon.js';
import { assemble, createRootConfig } from '../assembly/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from '../assembly/index.js';
import { DAEMON_FILE_ROUTING, DAEMON_INBOX_MESSAGE_TYPES } from './index.js';
import type { AssembleConfig, Instances } from '../assembly/index.js';

// shim 早期注册（在 daemon command 调用之前；ESM imports hoist 与代码执行解耦）
const shimAudit = constructShimAudit(process.argv[2]);
registerShimHandlers(shimAudit);

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
  auditEvents: {
    assembleFailed: ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
    daemonStart: ASSEMBLY_AUDIT_EVENTS.DAEMON_START,
    daemonCrash: ASSEMBLY_AUDIT_EVENTS.DAEMON_CRASH,
  },
});

await daemonCommand(process.argv[2]);
