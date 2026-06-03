/**
 * @module L6.Daemon
 * @layer L6 进程边界（Daemon 后台进程入口）
 * @depends L1.FileSystem, L2.AuditLog, L4.ContractSystem
 * @consumers L6.CLI（spawn）
 * @contract design/modules/l6_daemon.md
 *
 * Daemon 主入口 — 启动 Runtime 并保持运行至 SIGTERM。
 */

import * as path from 'path';
import { createHash } from 'node:crypto';
import { formatErr } from '../foundation/utils/index.js';
import { loadGlobalConfig, loadClawConfig, getClawDir, getNamedSubrootDir } from '../foundation/config/index.js';
import { MOTION_CLAW_ID } from '../constants.js';

import { startDaemonLoop } from './daemon-loop.js';
import { createSystemAudit, type AuditLog } from '../foundation/audit/index.js';
import { createAgentProcessManager } from '../foundation/process-manager/index.js';
import { isFileNotFound } from '../foundation/fs/types.js';
import { INBOX_PENDING_DIR } from '../foundation/messaging/index.js';
import type { FileSystem } from '../foundation/fs/types.js';

import { LockConflictError } from '../foundation/process-manager/index.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import type { DaemonInstances } from './types.js';

import { makeClawId, type ClawId } from '../foundation/identity/index.js';
import { type ClawDir, makeClawDir } from '../foundation/identity/index.js';


export interface DaemonCommandDeps {
  fsFactory: (baseDir: string) => FileSystem;
  assemble: (config: {
    identity: 'motion' | 'claw';
    clawId: ClawId;
    clawDir: ClawDir;
    globalConfig: any;
    clawConfig: any | null;
  }) => Promise<DaemonInstances>;
  disassemble: (instances: DaemonInstances, signal: string) => Promise<void>;
  auditEvents: {
    assembleFailed: string;
    daemonStart: string;
    daemonCrash: string;
  };
}

export function createDaemonCommand(deps: DaemonCommandDeps) {
  return async function daemonCommand(name: string): Promise<void> {
    const clawId = makeClawId(name);
    const globalConfig = loadGlobalConfig({ fsFactory: deps.fsFactory });
    const isMotion = name === MOTION_CLAW_ID;

    // 配置
    const dir = isMotion ? makeClawDir(getNamedSubrootDir('motion')) : getClawDir(name);

    // pre-assemble audit sink（phase189 §7.A3 清零；assemble 前的失败也需 audit）
    const preAssembleFs = deps.fsFactory(dir);
    const preAssembleAudit: AuditLog = createSystemAudit(preAssembleFs, dir);

    // ProcessManager 接管 PID 文件
    const processManager = createAgentProcessManager({ fsFactory: deps.fsFactory }, preAssembleAudit);

    // 写 PID 文件（兜底：无论启动方式都确保 PID 可查）
    await processManager.selfWritePid(clawId);

    const clawConfig = isMotion ? null : loadClawConfig({ fsFactory: deps.fsFactory }, name);

    // Assembly 装配
    let instances: DaemonInstances;
    try {
      instances = await deps.assemble({
        identity: isMotion ? 'motion' : 'claw', // identity='motion' literal
        clawId: clawId,
        clawDir: dir,
        globalConfig,
        clawConfig,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      if (e instanceof LockConflictError) {
        preAssembleAudit.write(deps.auditEvents.assembleFailed, 'module=lockfile', 'phase=preconstruct', `reason=${reason}`);
        process.exit(1);
      }
      preAssembleAudit.write(deps.auditEvents.assembleFailed, 'module=pre_assemble', 'phase=preconstruct', `reason=${reason}`);
      process.exit(1);
    }

    const { runtime, streamWriter, snapshot, auditWriter, heartbeat } = instances;

    try {
      await runtime.initialize();
    } catch (e) {
      // 兜底：Runtime 侧若已精确 audit（如 inboxReader.init / sessionManager.save）此行幂等重复；
      // Runtime 侧漏网的失败由此行唯一覆盖，postmortem 信号"需补精确 audit"
      auditWriter.write(deps.auditEvents.assembleFailed, `module=runtime`, `phase=post_assemble_init`, `reason=${formatErr(e)}`);
      process.exit(1);
    }

    // 清理残留心跳（上次 daemon 的遗留，重启后无需立即巡查）
    try {
      const entries = await preAssembleFs.list(INBOX_PENDING_DIR);
      for (const entry of entries) {
        if (entry.name.includes('_heartbeat_')) {
          await preAssembleFs.delete(path.join(INBOX_PENDING_DIR, entry.name));
        }
      }
    } catch (e: any) {
      if (!isFileNotFound(e)) {
        auditWriter.write(DAEMON_AUDIT_EVENTS.CLEANUP_HEARTBEAT_FAILED, `reason=${e?.message}`);
      }
    }

    // daemon_start: 计算 AGENTS.md 的 sha256 前 6 位作为 system prompt 版本标识
    let promptHash = 'n/a';
    try {
      const agentsContent = preAssembleFs.readSync('AGENTS.md');
      promptHash = createHash('sha256').update(agentsContent).digest('hex').slice(0, 6);
    } catch { /* silent: AGENTS.md is optional, missing is expected */ }
    auditWriter.write(deps.auditEvents.daemonStart, `sha256:${promptHash}`);
    await processManager.markReady(clawId);

    // daemon-start commit（不阻塞启动）
    snapshot.commit(`daemon-start ${new Date().toISOString()}`).then((result) => {
      if (!result.ok) {
        if (result.error.kind === 'uncategorized') {
          auditWriter.write(DAEMON_AUDIT_EVENTS.SNAPSHOT_COMMIT_UNCATEGORIZED, `context=daemon-start`, `exitCode=${result.error.exitCode}`);
        } else {
          auditWriter.write(DAEMON_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, `context=daemon-start`, `kind=${result.error.kind}`);
        }
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
      auditWriter.write(deps.auditEvents.daemonCrash, `error=${msg}`);
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
      fsFactory: deps.fsFactory,
      runtime,
      agentDir: dir,
      clawId: clawId,
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
      await deps.disassemble(instances, signal);

      // pid 文件清理（业务）
      try {
        await processManager.selfRemovePid(clawId);
      } catch (e: any) {
        instances.auditWriter.write(DAEMON_AUDIT_EVENTS.CLEANUP_PID_FAILED, `reason=${e?.message}`);
      }
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await promise;
  };
}
