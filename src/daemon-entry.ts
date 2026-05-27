import { NodeFileSystem } from './foundation/fs/node-fs.js';
import type { FileSystem } from './foundation/fs/types.js';
import { createSystemAudit, type AuditLog } from './foundation/audit/index.js';
import { getClawDir, getNamedSubrootDir } from './foundation/config/index.js';
import { MOTION_CLAW_ID } from './constants.js';

// shim pre-assemble audit sink（phase189 §7.A7 清零）
// 独立于 daemon.ts 的 preAssembleAudit：shim 在 daemon.ts 未入时兜底
const fsFactory = (baseDir: string): FileSystem => new NodeFileSystem({ baseDir });

let shimAudit: AuditLog | null = null;
try {
  const rawName = process.argv[2];
  // Phase 1200: daemon entry argv schema validate
  if (typeof rawName !== 'string' || rawName === '' || rawName === '.' || rawName.startsWith('.') || rawName.includes('/') || rawName.includes('\\') || /[\x00-\x1f]/.test(rawName) || rawName.includes('..')) {
    throw new Error(`Invalid daemon argv[2]: ${JSON.stringify(rawName)}`);
  }
  const name = rawName;
  const dir = name === MOTION_CLAW_ID ? makeClawDir(getNamedSubrootDir('motion')) : getClawDir(name);
  const shimFs: FileSystem = fsFactory(dir);
  shimAudit = createSystemAudit(shimFs, dir);
} catch {
  shimAudit = null;  // audit sink 构造失败 → handler fallback console
}

const errMsg = (reason: unknown): string =>
  reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);

process.on('unhandledRejection', (reason) => {
  const msg = errMsg(reason);
  try {
    shimAudit?.write('daemon_unhandled_rejection', `error=${msg}`);
  } catch { /* audit 写入失败静默，fallback console 保运维可见 */ }
  console.error('[daemon] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  const msg = errMsg(err);
  try {
    shimAudit?.write('daemon_uncaught_exception', `error=${msg}`);
  } catch { /* silent: audit-down 时 fallback console 保运维可见 / 已是 last-resort fallback / 不可再 audit 自身 */ }
  console.error('[daemon] Uncaught exception:', err);
  process.exit(1);
});

import { createDaemonCommand } from './daemon/daemon.js';
import { CONFIG_DEFAULTS } from './assembly/config-defaults.js';
import { assemble, disassemble } from './assembly/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from './assembly/audit-events.js';
import { makeClawDir } from './foundation/identity/index.js';

const daemonCommand = createDaemonCommand({
  fsFactory,
  configDefaults: CONFIG_DEFAULTS,
  assemble,
  disassemble,
  auditEvents: {
    assembleFailed: ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED,
    daemonStart: ASSEMBLY_AUDIT_EVENTS.DAEMON_START,
    daemonCrash: ASSEMBLY_AUDIT_EVENTS.DAEMON_CRASH,
  },
});

await daemonCommand(process.argv[2]);
