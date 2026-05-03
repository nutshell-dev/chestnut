/**
 * @module L6a.Daemon
 * @layer L6a 应用层（Daemon 后台进程入口）
 * @depends L1.FileSystem, L2.AuditLog, L4.Contract, L6b.CLI, L6c.Assembly
 * @consumers L6b.CLI（spawn）
 * @contract design/modules/l6_daemon.md
 *
 * Daemon 主入口 — 启动 Runtime 并保持运行至 SIGTERM。
 */

import * as path from 'path';
import * as fsNative from 'fs';
import * as fsAsync from 'fs/promises';
import { createHash } from 'node:crypto';
import { loadGlobalConfig, loadClawConfig, getClawDir, getMotionDir } from '../foundation/config/index.js';

import { startDaemonLoop } from './daemon-loop.js';
import { NodeFileSystem } from '../foundation/fs/node-fs.js';
import { AuditWriter } from '../foundation/audit/writer.js';
import { createSystemAudit, type AuditLog } from '../foundation/audit/index.js';
import { createAgentProcessManager } from '../foundation/process-manager/agent-factory.js';

import { CliError } from '../cli/errors.js';
import { assemble, disassemble } from '../assembly/index.js';
import { LockConflictError } from '../foundation/process-manager/index.js';
import { ASSEMBLY_AUDIT_EVENTS } from '../assembly/audit-events.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import type { Instances } from '../assembly/index.js';



/**
 * 守护进程主函数（支持 claw 和 motion）
 */
export async function daemonCommand(name: string): Promise<void> {
  const globalConfig = loadGlobalConfig();
  const isMotion = name === 'motion';

  // 配置
  const dir = isMotion ? getMotionDir() : getClawDir(name);

  // pre-assemble audit sink（phase189 §7.A3 清零；assemble 前的失败也需 audit）
  const preAssembleFs = new NodeFileSystem({ baseDir: dir });
  const preAssembleAudit: AuditLog = createSystemAudit(preAssembleFs, dir);

  // ProcessManager 接管 PID 文件
  const processManager = createAgentProcessManager(preAssembleAudit);
  
  // 写 PID 文件（兜底：无论启动方式都确保 PID 可查）
  await processManager.selfWritePid(name);
  
  const clawConfig = isMotion ? null : loadClawConfig(name);

  // Assembly 装配
  let instances: Instances;
  try {
    instances = await assemble({
      identity: isMotion ? 'motion' : 'claw',
      clawId: name,
      clawDir: dir,
      globalConfig,
      clawConfig,
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (e instanceof LockConflictError) {
      preAssembleAudit.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, 'module=lockfile', 'phase=preconstruct', `reason=${reason}`);
      console.error(`[daemon] ${e.message}`);
      process.exit(1);
    }
    preAssembleAudit.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, 'module=pre_assemble', 'phase=preconstruct', `reason=${reason}`);
    console.error('[daemon] assemble failed:', reason);
    process.exit(1);
  }

  const { runtime, streamWriter, snapshot, auditWriter, heartbeat } = instances;

  try {
    await runtime.initialize();
    await runtime.resumeContractIfPaused();
  } catch (e) {
    // 兜底：Runtime 侧若已精确 audit（如 inboxReader.init / sessionManager.save）此行幂等重复；
    // Runtime 侧漏网的失败由此行唯一覆盖，postmortem 信号"需补精确 audit"
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.ASSEMBLE_FAILED, `module=runtime`, `phase=post_assemble_init`, `reason=${errMsg(e)}`);
    console.error('[daemon] runtime init failed:', errMsg(e));
    process.exit(1);
  }

  // 清理残留心跳（上次 daemon 的遗留，重启后无需立即巡查）
  try {
    const pendingDir = path.join(dir, 'inbox', 'pending');
    const files = fsNative.readdirSync(pendingDir);
    for (const f of files) {
      if (f.includes('_heartbeat_')) {
        fsNative.unlinkSync(path.join(pendingDir, f));
      }
    }
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn(`[daemon] Failed to clean up heartbeat files: ${e?.message}`);
    }
  }

  // daemon_start: 计算 AGENTS.md 的 sha256 前 6 位作为 system prompt 版本标识
  let promptHash = 'n/a';
  try {
    const agentsContent = fsNative.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
    promptHash = createHash('sha256').update(agentsContent).digest('hex').slice(0, 6);
  } catch { /* AGENTS.md 不存在时跳过 */ }
  auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_START, `sha256:${promptHash}`);

  // daemon-start commit（不阻塞启动）
  snapshot.commit(`daemon-start ${new Date().toISOString()}`).then((result) => {
    if (!result.ok && result.error.kind === 'uncategorized') {
      auditWriter.write(DAEMON_AUDIT_EVENTS.SNAPSHOT_COMMIT_UNCATEGORIZED, `context=daemon-start`, `exitCode=${result.error.exitCode}`);
    }
  }).catch((err: unknown) => {
    // 不可预期失败：audit 已在 snapshot 内写
    auditWriter.write(DAEMON_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, `context=daemon-start`, `reason=${err instanceof Error ? err.message : String(err)}`);
  });

  const inboxPendingDir = path.join(dir, 'inbox', 'pending');

  // phase411: review_request 处理已由 ContractSystem.contract_completed → EvolutionSystem.runRetroForContract 接管
  // onInboxMessages 不再需要（原 review_request 处理器已移除）
  const onInboxMessages = undefined;

  // 注册 uncaughtException / unhandledRejection 处理程序
  const writeCrash = (reason: unknown): void => {
    const msg = reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ''}`
      : String(reason);
    auditWriter.write(ASSEMBLY_AUDIT_EVENTS.DAEMON_CRASH, `err=${msg}`);
  };

  process.on('uncaughtException', (err) => {
    writeCrash(err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    writeCrash(reason);
    process.exit(1);
  });

  const { promise, stop } = startDaemonLoop({
    runtime,
    agentDir: dir,
    clawId: name,
    label: isMotion ? '[motion daemon]' : '[daemon]',
    audit: auditWriter,
    inbox: { pendingDir: inboxPendingDir },
    motion: isMotion
      ? { heartbeat: heartbeat ?? undefined, onInboxMessages }
      : undefined,
    streamWriter,
  });

  // shutdown
  const shutdown = async (signal: string) => {
    stop();
    await disassemble(instances, signal);

    // pid 文件清理（业务）
    try {
      await processManager.selfRemovePid(name);
    } catch (e: any) {
      console.warn(`[daemon] Failed to clean up pid file: ${e?.message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const label = isMotion ? '[motion daemon]' : '[daemon]';
  console.log(`${label} Started`);
  await promise;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
