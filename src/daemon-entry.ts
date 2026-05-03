import { NodeFileSystem } from './foundation/fs/node-fs.js';
import { createSystemAudit, type AuditLog } from './foundation/audit/index.js';
import { getClawDir, getMotionDir } from './foundation/config/index.js';

// shim pre-assemble audit sink（phase189 §7.A7 清零）
// 独立于 daemon.ts 的 preAssembleAudit：shim 在 daemon.ts 未入时兜底
let shimAudit: AuditLog | null = null;
try {
  const name = process.argv[2];
  const dir = name === 'motion' ? getMotionDir() : getClawDir(name);
  const shimFs = new NodeFileSystem({ baseDir: dir });
  shimAudit = createSystemAudit(shimFs, dir);
} catch {
  shimAudit = null;  // audit sink 构造失败 → handler fallback console
}

const errMsg = (reason: unknown): string =>
  reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason);

process.on('unhandledRejection', (reason) => {
  const msg = errMsg(reason);
  try {
    shimAudit?.write('daemon_unhandled_rejection', `err=${msg}`);
  } catch { /* audit 写入失败静默，fallback console 保运维可见 */ }
  console.error('[daemon] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  const msg = errMsg(err);
  try {
    shimAudit?.write('daemon_uncaught_exception', `err=${msg}`);
  } catch { /* 同上 */ }
  console.error('[daemon] Uncaught exception:', err);
  process.exit(1);
});

import { daemonCommand } from './daemon/daemon.js';
await daemonCommand(process.argv[2]);
