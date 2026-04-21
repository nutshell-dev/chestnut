/**
 * daemon command - main daemon entry point
 *
 * Supports foreground execution (CLAWFORUM_DAEMON_MODE) and automatic background launch via CLI
 * Responsible for starting ClawRuntime and keeping it running until SIGTERM is received
 */

import * as path from 'path';
import * as fsNative from 'fs';
import * as fsAsync from 'fs/promises';
import { createHash } from 'node:crypto';
import { loadGlobalConfig, loadClawConfig, getClawDir, getMotionDir } from '../config.js';
import type { InboxMessage } from '../../types/contract.js';
import { startDaemonLoop } from './daemon-loop.js';
import { NodeFileSystem } from '../../foundation/fs/node-fs.js';
import { AuditWriter } from '../../foundation/audit/writer.js';
import { ContractManager, type MotionReviewContext } from '../../core/contract/manager.js';
import { CliError } from '../errors.js';
import { assemble, disassemble, LockConflictError } from '../../assembly/index.js';
import type { Instances } from '../../assembly/index.js';



/**
 * 守护进程主函数（支持 claw 和 motion）
 */
export async function daemonCommand(name: string): Promise<void> {
  const globalConfig = loadGlobalConfig();
  const isMotion = name === 'motion';

  // 配置
  const dir = isMotion ? getMotionDir() : getClawDir(name);
  
  // lockfile 单实例保护（先写 PID 文件，后续用 ProcessManager 接管）
  const statusDir = path.join(dir, 'status');
  const pidFile = path.join(statusDir, 'pid');
  
  // 写 PID 文件（兜底：无论启动方式都确保 PID 可查）
  fsNative.writeFileSync(pidFile, String(process.pid));
  
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
    if (e instanceof LockConflictError) {
      console.error(`[daemon] ${e.message}`);
      process.exit(1);
    }
    console.error('[daemon] assemble failed:', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const { runtime, streamWriter, snapshot, auditWriter, heartbeat } = instances;

  try {
    await runtime.initialize();
    await runtime.resumeContractIfPaused();
  } catch (e) {
    // 兜底：Runtime 侧若已精确 audit（如 inboxReader.init / sessionManager.save）此行幂等重复；
    // Runtime 侧漏网的失败由此行唯一覆盖，postmortem 信号"需补精确 audit"
    auditWriter.write('assemble_failed', `module=runtime`, `phase=post_assemble_init`, `reason=${errMsg(e)}`);
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
  auditWriter.write('daemon_start', `sha256:${promptHash}`);

  // daemon-start commit（不阻塞启动）
  snapshot.commit(`daemon-start ${new Date().toISOString()}`).then((result) => {
    if (!result.ok && result.error.kind === 'uncategorized') {
      auditWriter.write('snapshot_commit_uncategorized', `context=daemon-start`, `exitCode=${result.error.exitCode}`);
    }
  }).catch((err: unknown) => {
    // 不可预期失败：audit 已在 snapshot 内写
    auditWriter.write('snapshot_commit_failed', `context=daemon-start`, `reason=${err instanceof Error ? err.message : String(err)}`);
  });

  const inboxPendingDir = path.join(dir, 'inbox', 'pending');

  // review_request → ContractManager.handleReviewRequest（B.p172-3 迁移完成 phase188）
  const motionFs = isMotion ? new NodeFileSystem({ baseDir: dir, enforcePermissions: false }) : undefined;
  const contractManager = isMotion && motionFs ? new ContractManager(dir, 'motion', motionFs) : undefined;
  const clawsBaseDir = isMotion ? path.resolve(dir, '..', 'claws') : undefined;

  const reviewCtx: MotionReviewContext | undefined = isMotion && motionFs && clawsBaseDir
    ? { motionFs, motionBaseDir: dir, motionAudit: auditWriter, clawsBaseDir }
    : undefined;

  // 注册 review_request 处理器（仅 motion）
  const onInboxMessages = isMotion
    ? async (messages: InboxMessage[]) => {
        for (const message of messages) {
          if (message.type !== 'review_request') continue;
          const contractId = message.contract_id;
          if (!contractId) continue;

          // phase184 新路径：委托 ContractManager.handleReviewRequest
          if (contractManager && reviewCtx) {
            await contractManager.handleReviewRequest(contractId, reviewCtx);
            continue;
          }

        }
      }
    : undefined;

  // 注册 uncaughtException / unhandledRejection 处理程序
  const writeCrash = (reason: unknown): void => {
    const msg = reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ''}`
      : String(reason);
    auditWriter.write('daemon_crash', `err=${msg}`);
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
    inboxPendingDir,
    label: isMotion ? '[motion daemon]' : '[daemon]',
    streamWriter,
    heartbeat: heartbeat ?? undefined,  // 传入心跳实例
    onInboxMessages,   // 新增
    audit: auditWriter,
  });

  // shutdown
  const shutdown = async (signal: string) => {
    stop();
    await disassemble(instances, signal);

    // pid 文件清理（业务）
    try {
      const storedPid = fsNative.readFileSync(pidFile, 'utf-8').trim();
      if (storedPid === String(process.pid)) fsNative.unlinkSync(pidFile);
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
