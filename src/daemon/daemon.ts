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
import { sha256ShortHex } from '../foundation/hash.js';
import { formatErr } from '../foundation/utils/index.js';
import { loadGlobalConfig, loadClawConfig } from '../assembly/config-load.js';
import { getClawDir, getNamedSubrootDir, getClawConfigPath } from '../foundation/config/index.js';
import { MOTION_CLAW_ID } from '../core/claw-topology/index.js';

import { startDaemonLoop } from './daemon-loop.js';
import { createSystemAudit, type AuditLog } from '../foundation/audit/index.js';
import { createAgentProcessManager } from '../foundation/process-manager/index.js';
import { makeClawId } from '../foundation/identity/index.js';
import { isFileNotFound } from '../foundation/fs/types.js';
import { INBOX_PENDING_DIR } from '../foundation/messaging/index.js';
import type { FileSystem } from '../foundation/fs/types.js';

import { LockConflictError } from '../foundation/process-manager/index.js';
import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import type { DaemonInstances } from './types.js';
import { CLAW_SPEC_FILE } from '../foundation/claw-paths.js';
import type { AssembleConfig } from '../assembly/types.js';

// phase 175: idempotent signal handler refs（mirror watchdog.ts:60-61 pattern、防 test re-entry 累 listener）
// phase 517 B2: handler 返 Promise（Node 忽略、但测试可 await 验 dispose + exit 时序）
let uncaughtHandler: ((err: Error) => void | Promise<void>) | null = null;
let unhandledRejectionHandler: ((reason: unknown) => void | Promise<void>) | null = null;
let sigtermHandler: (() => void) | null = null;
let sigintHandler: (() => void) | null = null;

/** Test-only: reset all 4 daemon signal handlers between tests (mirror watchdog `_resetShutdownGuard`) */
export function _resetDaemonSignalHandlers(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetDaemonSignalHandlers is for tests only');
  }
  if (uncaughtHandler) { process.removeListener('uncaughtException', uncaughtHandler); uncaughtHandler = null; }
  if (unhandledRejectionHandler) { process.removeListener('unhandledRejection', unhandledRejectionHandler); unhandledRejectionHandler = null; }
  if (sigtermHandler) { process.removeListener('SIGTERM', sigtermHandler); sigtermHandler = null; }
  if (sigintHandler) { process.removeListener('SIGINT', sigintHandler); sigintHandler = null; }
}

export interface DaemonCommandDeps {
  fsFactory: (baseDir: string) => FileSystem;
  // phase 386: inline anonymous type 替为 AssembleConfig (assembly/types.ts) —
  // ML#9 显式表达（不可消除耦合优先编译器检查）+ ML#1 单源真理（消 inline `any` 类型逃逸 + 类型字段重复）
  assemble: (config: AssembleConfig) => Promise<DaemonInstances>;
  disassemble: (instances: DaemonInstances, signal: string) => Promise<void>;
  auditEvents: {
    assembleFailed: string;
    daemonStart: string;
    daemonCrash: string;
  };
  /**
   * motion daemon 自审 watchdog 存活探针。isMotion=true 时 caller 必传；
   * claw daemon 路径不进自审分支、不传亦不触。
   * phase 444 DI：避免 daemon-loop 直 import watchdog 模块（M#5 单向）。
   */
  watchdogAliveProbe?: () => boolean;
}

export function createDaemonCommand(deps: DaemonCommandDeps) {
  return async function daemonCommand(name: string): Promise<void> {
    const clawId = name;
    const globalConfig = loadGlobalConfig({ fsFactory: deps.fsFactory });
    const isMotion = name === MOTION_CLAW_ID;

    // 配置
    const dir = isMotion ? getNamedSubrootDir('motion') : getClawDir(name);

    // pre-assemble audit sink（phase189 §7.A3 清零；assemble 前的失败也需 audit）
    const preAssembleFs = deps.fsFactory(dir);
    const preAssembleAudit: AuditLog = createSystemAudit(preAssembleFs, dir);

    // ProcessManager 接管 PID 文件
    const processManager = createAgentProcessManager({ fsFactory: deps.fsFactory, motionClawId: MOTION_CLAW_ID }, preAssembleAudit);

    // phase 521 (review-round4 CLI M): loadClawConfig 包入 try 显式归类 module=claw_config
    // YAML parse error 改前 escape 到 shim 无 ASSEMBLE_FAILED granularity
    let clawConfig: ReturnType<typeof loadClawConfig> | null = null;
    if (!isMotion) {
      try {
        clawConfig = loadClawConfig({ fsFactory: deps.fsFactory }, getClawConfigPath(name));
      } catch (e) {
        const reason = formatErr(e);
        preAssembleAudit.write(deps.auditEvents.assembleFailed, 'module=claw_config', 'phase=preconstruct', `reason=${reason}`);
        preAssembleAudit.dispose?.();
        process.exit(1);
      }
    }

    // Assembly 装配（phase 324 H1：先取锁、再写 PID。
    // 若先写 PID，losing 实例会在 LockConflictError 前覆盖上家 PID 文件 →
    // pm.isAlive 谎报、stop 找不到真进程、watchdog 重生 race。）
    let instances: DaemonInstances;
    try {
      instances = await deps.assemble({
        identity: isMotion ? 'motion' : 'claw', // identity='motion' literal
        clawId: clawId,
        clawDir: dir,
        globalConfig,
        // phase 386: AssembleConfig.clawConfig 是 `ClawConfig | null`、loadClawConfig 返 `... | undefined` → coalesce null
        clawConfig: clawConfig ?? null,
      });
    } catch (e) {
      const reason = formatErr(e);
      if (e instanceof LockConflictError) {
        preAssembleAudit.write(deps.auditEvents.assembleFailed, 'module=lockfile', 'phase=preconstruct', `reason=${reason}`);
        preAssembleAudit.dispose?.();  // phase 467 (review N3-L): flush batched audit 前 exit、防丢 telemetry
        process.exit(1);
      }
      preAssembleAudit.write(deps.auditEvents.assembleFailed, 'module=pre_assemble', 'phase=preconstruct', `reason=${reason}`);
      preAssembleAudit.dispose?.();  // phase 467 (review N3-L)
      process.exit(1);
    }

    // 锁取成后写 PID 文件（兜底：无论启动方式都确保 PID 可查）
    await processManager.selfWritePid(makeClawId(clawId));

    const { runtime, streamWriter, snapshot, auditWriter, heartbeat } = instances;

    try {
      await runtime.initialize();
    } catch (e) {
      // 兜底：Runtime 侧若已精确 audit（如 inboxReader.init / sessionManager.save）此行幂等重复；
      // Runtime 侧漏网的失败由此行唯一覆盖，postmortem 信号"需补精确 audit"
      auditWriter.write(deps.auditEvents.assembleFailed, `module=runtime`, `phase=post_assemble_init`, `reason=${formatErr(e)}`);
      auditWriter.dispose?.();  // phase 467 (review N3-L): flush 前 exit
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
    } catch (e) {
      if (!isFileNotFound(e)) {
        auditWriter.write(DAEMON_AUDIT_EVENTS.CLEANUP_HEARTBEAT_FAILED, `reason=${(e as Error).message}`);
      }
    }

    // daemon_start: 计算 AGENTS.md 的 sha256 前 6 位作为 system prompt 版本标识
    let promptHash = 'n/a';
    try {
      const agentsContent = preAssembleFs.readSync(CLAW_SPEC_FILE);
      promptHash = sha256ShortHex(agentsContent, 6);
    } catch { /* silent: AGENTS.md is optional, missing is expected */ }
    auditWriter.write(deps.auditEvents.daemonStart, `sha256:${promptHash}`);
    await processManager.markReady(makeClawId(clawId));

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
      auditWriter.write(DAEMON_AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED, `context=daemon-start`, `reason=${formatErr(err)}`);
    });

    const inboxPendingDir = path.join(dir, INBOX_PENDING_DIR);


    // 注册 uncaughtException / unhandledRejection 处理程序
    const writeCrash = (reason: unknown): void => {
      const msg = reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ''}`
        : String(reason);
      auditWriter.write(deps.auditEvents.daemonCrash, `error=${msg}`);
    };

    const { promise, stop } = startDaemonLoop({
      fsFactory: deps.fsFactory,
      runtime,
      agentDir: dir,
      clawId: clawId,
      label: isMotion ? '[motion daemon]' : '[daemon]',
      audit: auditWriter,
      inbox: { pendingDir: inboxPendingDir },
      motion: isMotion
        ? (() => {
            // phase 521 (review-round4 CLI M): 非空断言改显式 throw、防 test 构造缺 probe + motion 分支致 undefined() crash
            if (!deps.watchdogAliveProbe) {
              throw new Error('daemon: deps.watchdogAliveProbe required for motion mode');
            }
            return { heartbeat: heartbeat ?? undefined, watchdogAliveProbe: deps.watchdogAliveProbe };
          })()
        : undefined,
      streamWriter,
    });

    /**
     * phase 517 B2: shared graceful shutdown between SIGTERM/SIGINT and uncaught/unhandledRejection.
     * normal: 30s timeout / crash: 5s timeout (avoid hang on dispose 内死锁).
     * 原 uncaught/unhandledRejection 仅 flush audit、不调 disassemble → runtime/task/cron/contract
     * 资源强杀（verifier LLM stream 泄漏、cron handler 强杀、pid 残留等）。
     */
    const gracefulShutdown = async (reason: string, timeoutMs: number): Promise<void> => {
      stop();
      const dispose = (async () => {
        await deps.disassemble(instances, reason);
        try {
          await processManager.selfRemovePid(makeClawId(clawId));
        } catch (e) {
          instances.auditWriter.write(DAEMON_AUDIT_EVENTS.CLEANUP_PID_FAILED, `reason=${(e as Error).message}`);
        }
      })().catch((e) => {
        instances.auditWriter.write(DAEMON_AUDIT_EVENTS.CLEANUP_PID_FAILED, `dispose_failed=${formatErr(e)}`);
      });
      await Promise.race([
        dispose,
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
      ]);
    };

    // phase 175: idempotent install
    if (uncaughtHandler) process.removeListener('uncaughtException', uncaughtHandler);
    if (unhandledRejectionHandler) process.removeListener('unhandledRejection', unhandledRejectionHandler);
    uncaughtHandler = (err) => {
      writeCrash(err);
      // phase 517 B2: crash 路径也走 graceful shutdown（5s timeout 兜底防 dispose 死锁）
      // return Promise → Node 实际忽略、但测试可 await 验 exit + audit；类型由 listener void-return 兼容
      return gracefulShutdown('uncaughtException', 5_000).finally(() => {
        auditWriter.dispose?.();  // phase 477: flush batched audit 前 exit
        process.exit(1);
      });
    };
    unhandledRejectionHandler = (reason) => {
      writeCrash(reason);
      return gracefulShutdown('unhandledRejection', 5_000).finally(() => {
        auditWriter.dispose?.();
        process.exit(1);
      });
    };
    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);

    // shutdown (SIGTERM/SIGINT)
    const shutdown = async (signal: string): Promise<void> => {
      await gracefulShutdown(signal, 30_000);
      process.exit(0);
    };
    // phase 175: idempotent install
    if (sigtermHandler) process.removeListener('SIGTERM', sigtermHandler);
    if (sigintHandler) process.removeListener('SIGINT', sigintHandler);
    sigtermHandler = () => shutdown('SIGTERM');
    sigintHandler = () => shutdown('SIGINT');
    process.on('SIGTERM', sigtermHandler);
    process.on('SIGINT', sigintHandler);

    await promise;
  };
}
