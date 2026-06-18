import { NodeFileSystem } from './foundation/fs/node-fs.js';
import { constructShimAudit, registerShimHandlers } from './daemon-handlers.js';
import { createDaemonCommand } from './daemon/daemon.js';
import { assemble, disassemble } from './assembly/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from './assembly/index.js';

// shim 早期注册（在 daemon command 调用之前；ESM imports hoist 与代码执行解耦）
const shimAudit = constructShimAudit(process.argv[2]);
registerShimHandlers(shimAudit);

const daemonCommand = createDaemonCommand({
  fsFactory: (baseDir) => new NodeFileSystem({ baseDir }),
  assemble,
  disassemble,
  auditEvents: {
    assembleFailed: ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
    daemonStart: ASSEMBLY_AUDIT_EVENTS.DAEMON_START,
    daemonCrash: ASSEMBLY_AUDIT_EVENTS.DAEMON_CRASH,
  },
});

await daemonCommand(process.argv[2]);
