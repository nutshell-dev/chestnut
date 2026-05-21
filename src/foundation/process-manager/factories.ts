/**
 * Process-manager factories — shared by CLI and Watchdog (L2).
 *
 * §1 所有权：
 *   - 职责：为 CLI 命令（非 daemon）提供 ProcessManager / DirContext 的统一构造入口
 *   - 消费者：CLI 命令、Watchdog、其他 L2+ 非 daemon 装配场景
 *   - 非职责：不装配 Runtime / Snapshot / Stream 等 L2+ 对象（由 Assembly 负责）
 *
 * §5 隐式依赖：
 *   - getClawforumRoot()（config.ts）：createProcessManagerForCLI 的 PM / audit 根
 *   - AUDIT_FILE 常量（foundation/audit）：createDirContext 的 audit relPath
 *   - NodeFileSystem 构造签名（foundation/fs）、AuditWriter 构造签名、createAgentProcessManager 签名
 */

import path from 'path';
import { NodeFileSystem } from '../fs/node-fs.js';
import { type AuditLog, createSystemAudit, AUDIT_FILE } from '../audit/index.js';
import type { FileSystem } from '../fs/types.js';
import type { ProcessManager } from './index.js';
import { createAgentProcessManager } from './agent-factory.js';
import { getClawforumRoot } from '../config/index.js';

/**
 * createProcessManagerForCLI
 *
 * 输入：
 *   - 无参数（内部固定 getClawforumRoot()）
 *
 * 输出：
 *   - ProcessManager 实例；每次调用返回新对象（无缓存、无单例）
 *   - PID / lockfile 根：clawforumRoot（不可配置，由 ProcessManager 内部决定）
 *   - audit 落盘：clawforumRoot/audit.tsv（跨 agent 的进程管理属 clawforum 层资源）
 *   - 回归原 createMotionPM 语义（phase154 定义）
 *
 * 边界：
 *   - 不 acquireLock；不写 audit；不校验目录存在性
 *   - OS-only（NodeFileSystem 0 PermissionChecker dep / phase430 caller 自治）
 *
 * 失败：
 *   - 构造失败（NodeFileSystem / createSystemAudit / createAgentProcessManager 任一抛错）→ 原样上抛
 *   - 不包装；调用方（CLI 命令）通常不 catch，让错误直接打印
 */
export function createProcessManagerForCLI(): ProcessManager {
  const baseDir = getClawforumRoot();
  const fs = new NodeFileSystem({ baseDir });
  const systemAudit = createSystemAudit(fs, baseDir);
  return createAgentProcessManager(systemAudit);
}

/**
 * createDirContext(dir)
 *
 * 输入：
 *   - dir: 绝对路径；必须是 audit.tsv 所在目录
 *
 * 输出：
 *   - { fs, audit } 配对对象；每次调用返回新实例
 *   - fs: NodeFileSystem({ baseDir: dir })
 *   - audit: new AuditWriter(fs, path.join(dir, AUDIT_FILE))
 *
 * 边界：
 *   - relPath 固定为 AUDIT_FILE 常量
 *   - 不 mkdir；audit.tsv 不存在时首次 write 会创建（AuditWriter 原生行为）
 *   - 不做 retention（maxSizeMb 参数留空，用 AuditWriter 默认）
 *
 * 失败：
 *   - 构造失败（NodeFileSystem / AuditWriter ctor）→ 原样上抛；调用方可 catch 包装 assemble_failed
 *   - audit.write 运行期失败 → AuditWriter 内部 try/catch 吞错 + console.error（沿用既有语义）
 *   - 若调用方需 fail-fast 写入语义 → 外层再包 try/catch 或绕开 audit 用裸 fs
 */
export function createDirContext(dir: string): {
  fs: FileSystem;
  audit: AuditLog;
} {
  const fs = new NodeFileSystem({ baseDir: dir });
  const audit = createSystemAudit(fs, dir);
  return { fs, audit };
}
