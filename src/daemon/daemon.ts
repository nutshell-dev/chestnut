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
import { sha256ShortHex } from '../foundation/node-utils/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import type { RootConfigReader } from '../assembly/index.js';
import { getClawDir, getNamedSubrootDir, getClawConfigPath } from '../foundation/claw-identity/index.js';
import { resolveClawDaemonDir, MOTION_CLAW_ID } from '../core/claw-topology/index.js';

import { startDaemonLoop } from './daemon-loop.js';
import { EventLoop } from '../core/event-loop/index.js';
import { createSystemAudit, type AuditLog, AUDIT_FILE } from '../foundation/audit/index.js';
import { summarizeLastExit } from './last-exit-summary.js';
import { createAgentProcessManager } from '../foundation/process-manager/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import { getProcessStartTime, type ProcessStartTime } from '../foundation/process-exec/index.js';
import { INBOX_PENDING_DIR, createInboxReader } from '../foundation/messaging/index.js';
import type { FileSystem } from '../foundation/fs/index.js';

import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import { CLAW_SPEC_FILE } from '../foundation/claw-identity/index.js';
import type { AssembleConfig, Instances } from '../assembly/index.js';
import type { DaemonDir } from '../foundation/process-manager/index.js';
import { PROCESS_GENERATION_ENV } from '../foundation/process-manager/index.js';
import type { ProcessGenerationRecord } from '../foundation/process-manager/index.js';

// phase 175: idempotent signal handler refs（mirror watchdog.ts:60-61 pattern、防 test re-entry 累 listener）
// phase 517 B2: handler 返 Promise（Node 忽略、但测试可 await 验 dispose + exit 时序）
let uncaughtHandler: ((err: Error) => void | Promise<void>) | null = null;
let unhandledRejectionHandler: ((reason: unknown) => void | Promise<void>) | null = null;
let sigtermHandler: (() => void) | null = null;
let sigintHandler: (() => void) | null = null;

// phase 1124: shutdown 重入 guard（mirror watchdog.ts:87-111）
let shutdownStarted: string | null = null;

/** Test-only: reset all 4 daemon signal handlers between tests (mirror watchdog `_resetShutdownGuard`) */
export function _resetDaemonSignalHandlers(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetDaemonSignalHandlers is for tests only');
  }
  if (uncaughtHandler) { process.removeListener('uncaughtException', uncaughtHandler); uncaughtHandler = null; }
  if (unhandledRejectionHandler) { process.removeListener('unhandledRejection', unhandledRejectionHandler); unhandledRejectionHandler = null; }
  if (sigtermHandler) { process.removeListener('SIGTERM', sigtermHandler); sigtermHandler = null; }
  if (sigintHandler) { process.removeListener('SIGINT', sigintHandler); sigintHandler = null; }
  shutdownStarted = null;
}

interface DaemonCommandDeps {
  fsFactory: (baseDir: string) => FileSystem;
  rootConfig: Pick<RootConfigReader, 'loadGlobal' | 'loadClaw'>;
  // phase 386: inline anonymous type 替为 AssembleConfig (assembly/types.ts) —
  // ML#9 显式表达（不可消除耦合优先编译器检查）+ ML#1 单源真理（消 inline `any` 类型逃逸 + 类型字段重复）
  assemble: (config: AssembleConfig) => Promise<Instances>;
  auditEvents: {
    assembleFailed: string;
    daemonStart: string;
    daemonCrash: string;
  };
}

export function createDaemonCommand(deps: DaemonCommandDeps) {
  return async function daemonCommand(name: string): Promise<void> {
    const clawId = name;
    const globalConfig = deps.rootConfig.loadGlobal();
    const isMotion = name === MOTION_CLAW_ID;

    // 配置
    const dir = isMotion ? getNamedSubrootDir('motion') : getClawDir(name);
    const daemonDir = resolveClawDaemonDir(makeClawId(clawId));
    const processGenerationId = process.env[PROCESS_GENERATION_ENV];

    // pre-assemble audit sink（phase189 §7.A3 清零；assemble 前的失败也需 audit）
    const preAssembleFs = deps.fsFactory(dir);
    const preAssembleAudit: AuditLog = createSystemAudit(preAssembleFs, dir);

    // ProcessManager 由 Assembly 构造；daemon.ts 主要用 instances.processManager
    // 做 generation 激活与 shutdown retire。

    // phase 521 (review-round4 CLI M): loadClawConfig 包入 try 显式归类 module=claw_config
    // YAML parse error 改前 escape 到 shim 无 ASSEMBLE_FAILED granularity
    let clawConfig: ReturnType<DaemonCommandDeps['rootConfig']['loadClaw']> | null = null;
    if (!isMotion) {
      try {
        clawConfig = deps.rootConfig.loadClaw(getClawConfigPath(name));
      } catch (e) {
        const reason = formatErr(e);
        preAssembleAudit.write(deps.auditEvents.assembleFailed, 'module=claw_config', 'phase=preconstruct', `reason=${reason}`);
        preAssembleAudit.dispose?.();
        process.exit(1);
      }
    }

    // Assembly 装配（Phase 1204 Step C：lifecycle lock 已删除，child 凭显式
    // generation identity 在 Assembly 成功后激活 generation。）
    let instances: Instances;
    try {
      // phase 1872 Step B: AssembleConfig 判别联合——claw 分支 clawConfig 必填。
      // loadClaw 数据缺失（文件不存在/未建）是运行期数据条件（非静态非法输入），
      // 保留原 assemble 运行时校验的失败面：同一 reason 文案 + 同一审计/退出路径。
      let assembleConfig: AssembleConfig;
      if (isMotion) {
        assembleConfig = {
          identity: 'motion', // identity='motion' literal（行注释 allowlist）
          clawId: clawId,
          clawDir: dir,
          globalConfig,
          processGenerationId,
        };
      } else {
        if (!clawConfig) {
          throw new Error('clawConfig is required when identity=claw');
        }
        assembleConfig = {
          identity: 'claw',
          clawId: clawId,
          clawDir: dir,
          globalConfig,
          clawConfig,
          processGenerationId,
        };
      }
      instances = await deps.assemble(assembleConfig);
    } catch (e) {
      const reason = formatErr(e);
      preAssembleAudit.write(deps.auditEvents.assembleFailed, 'module=pre_assemble', 'phase=preconstruct', `reason=${reason}`);
      preAssembleAudit.dispose?.();  // phase 467 (review N3-L)
      process.exit(1);
    }

    const { runtime, streamWriter, snapshot, auditWriter, heartbeat, executionRecovery, recoverySession } = instances;

    // Phase 1204 Step C：child 校验 generation identity，写 ready 事实后激活 generation。
    let generationRecord: ProcessGenerationRecord | undefined;
    try {
      const startTime = getProcessStartTime(process.pid) as ProcessStartTime | undefined;
      const activationResult = await activateOwnGeneration(instances.processManager, daemonDir, processGenerationId, startTime);
      if (activationResult.kind !== 'ok') {
        throw new Error(activationResult.reason);
      }
      generationRecord = activationResult.record;
    } catch (e) {
      const reason = formatErr(e);
      auditWriter.write(deps.auditEvents.assembleFailed, 'module=generation_activation', 'phase=post_assemble', `reason=${reason}`);
      auditWriter.dispose?.();
      process.exit(1);
    }

    // phase 1124: 4 个 shutdown 入口统一重入 guard（mirror watchdog.ts:87-111）
    const beginShutdown = (cause: string): boolean => {
      if (shutdownStarted !== null) {
        auditWriter.write(
          DAEMON_AUDIT_EVENTS.SHUTDOWN_REENTRY_SUPPRESSED,
          `cause=${cause}`,
          `in_progress=${shutdownStarted}`,
        );
        return false;
      }
      shutdownStarted = cause;
      return true;
    };

    const inboxPendingDir = path.join(dir, INBOX_PENDING_DIR);

    const eventLoop = new EventLoop({
      runtime,
      fsFactory: deps.fsFactory,
      agentDir: dir,
      clawId: clawId,
      audit: auditWriter,
      inbox: { pendingDir: inboxPendingDir },
      streamWriter,
      // Phase 1396 Step E: 执行停滞恢复（Assembly 只注入持久事实 probe / async-task
      // 在途 probe 等观察依赖；Phase 1840 起提醒链无 failure sink 失败出口）
      executionRecovery,
      // Phase 1826: LLM 恢复安排 owner 的窄 capability（EventLoop 只执行安排与准入）
      recovery: recoverySession,
    });
    await eventLoop.initialize();

    const auditAbsPath = preAssembleFs.resolve(AUDIT_FILE);
    const interruptionMessage = summarizeLastExit(
      preAssembleFs,
      auditAbsPath,
      (error) => auditWriter.write(
        DAEMON_AUDIT_EVENTS.LAST_EXIT_SUMMARY_READ_FAILED,
        `path=${auditAbsPath}`,
        `reason=${formatErr(error)}`,
      ),
    ) ?? undefined;

    try {
      await runtime.initialize({ interruptionMessage });
    } catch (e) {
      // 兜底：Runtime 侧若已精确 audit（如 inboxReader.init / sessionManager.save）此行幂等重复；
      // Runtime 侧漏网的失败由此行唯一覆盖，postmortem 信号"需补精确 audit"
      auditWriter.write(deps.auditEvents.assembleFailed, `module=runtime`, `phase=post_assemble_init`, `reason=${formatErr(e)}`);
      auditWriter.dispose?.();  // phase 467 (review N3-L): flush 前 exit
      process.exit(1);
    }

    // 清理残留心跳（上次 daemon 的遗留，重启后无需立即巡查）
    // phase 1804: Messaging owner capability —— daemon 不见目录/文件名/删除动作；
    // typed identity（解码 meta.type）替代 '_heartbeat_' 文件名 substring 判断。
    {
      const inboxMaintenance = createInboxReader(preAssembleFs, preAssembleAudit, path.join(dir, 'inbox'));
      const cleanup = await inboxMaintenance.cleanupPendingByType('heartbeat');
      if (cleanup.kind === 'partial') {
        auditWriter.write(
          DAEMON_AUDIT_EVENTS.CLEANUP_HEARTBEAT_FAILED,
          `removed=${cleanup.removed}`,
          `reason=${cleanup.failures.map(f => f.error).join('; ')}`,
        );
      }
    }

    // daemon_start: 计算 AGENTS.md 的 sha256 前 6 位作为 system prompt 版本标识
    let promptHash = 'n/a';
    try {
      const agentsContent = preAssembleFs.readSync(CLAW_SPEC_FILE);
      promptHash = sha256ShortHex(agentsContent, 6);
    } catch { /* silent: AGENTS.md is optional, missing is expected */ }
    // phase 719: 'sha256:' algo prefix 不是 audit col key= prefix、forensic 解析无法 join、改 'prompt_hash=' key
    auditWriter.write(deps.auditEvents.daemonStart, `prompt_hash=sha256:${promptHash}`);
    // generation activation 已完成；legacy status/ready 不再由 daemon 写（Step E 删除 legacy 路径）。

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


    // 注册 uncaughtException / unhandledRejection 处理程序
    const writeCrash = (reason: unknown): void => {
      const msg = reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ''}`
        : String(reason);
      auditWriter.write(deps.auditEvents.daemonCrash, `error=${msg}`);
    };

    const { promise, stop } = startDaemonLoop({
      fsFactory: deps.fsFactory,
      eventLoop,
      agentDir: dir,
      clawId: clawId,
      label: isMotion ? '[motion daemon]' : '[daemon]',
      audit: auditWriter,
      motion: isMotion ? { heartbeat: heartbeat ?? undefined } : undefined,
    });

    /**
     * phase 517 B2: shared graceful shutdown between SIGTERM/SIGINT and uncaught/unhandledRejection.
     * normal: 30s timeout / crash: 5s timeout (avoid hang on dispose 内死锁).
     * 原 uncaught/unhandledRejection 仅 flush audit、不调 session dispose → runtime/task/cron/contract
     * 资源强杀（verifier LLM stream 泄漏、cron handler 强杀、pid 残留等）。
     */
    const gracefulShutdown = async (reason: string, timeoutMs: number): Promise<void> => {
      stop();
      const dispose = (async () => {
        await instances.dispose(reason);
        // Phase 1204 Step C：shutdown 时将本 generation 从 active retire（late retire
        // 由 identity match 保证不动 fresh generation）。
        if (generationRecord !== undefined) {
          try {
            instances.processManager.retireGeneration(daemonDir, { generationId: generationRecord.generation_id }, 'shutdown', 'active');
          } catch (e) {
            instances.auditWriter.write(DAEMON_AUDIT_EVENTS.CLEANUP_PID_FAILED, `context=retire_generation`, `reason=${(e as Error).message}`);
          }
        }
      })().catch((e) => {
        // phase 720: 加 context col 区分 caller 路径、改 raw 'dispose_failed=' 为统一 'reason=' key
        instances.auditWriter.write(DAEMON_AUDIT_EVENTS.CLEANUP_PID_FAILED, `context=dispose_failed_async`, `reason=${formatErr(e)}`);
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
      // phase 1124: crash 记录优先于 guard（独立 crash 均需留痕）
      if (!beginShutdown('uncaughtException')) return Promise.resolve();
      // phase 517 B2: crash 路径也走 graceful shutdown（5s timeout 兜底防 dispose 死锁）
      // return Promise → Node 实际忽略、但测试可 await 验 exit + audit；类型由 listener void-return 兼容
      return gracefulShutdown('uncaughtException', 5_000).finally(() => {
        auditWriter.dispose?.();  // phase 477: flush batched audit 前 exit
        process.exit(1);
      });
    };
    unhandledRejectionHandler = (reason) => {
      writeCrash(reason);
      // phase 1124: crash 记录优先于 guard
      if (!beginShutdown('unhandledRejection')) return Promise.resolve();
      return gracefulShutdown('unhandledRejection', 5_000).finally(() => {
        auditWriter.dispose?.();
        process.exit(1);
      });
    };
    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);

    // shutdown (SIGTERM/SIGINT)
    const shutdown = async (signal: string): Promise<void> => {
      if (!beginShutdown(signal)) return;  // phase 1124: 重入抑制、首个继续
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

interface GenerationActivationResult {
  kind: 'ok' | 'error';
  record?: ProcessGenerationRecord;
  reason?: string;
}

/**
 * Phase 1204 Step C: child 校验显式 generation identity，写 ready 事实后激活 generation。
 * child 只能 activate 与自身 PID/startTime 匹配的 spawning；任何 mismatch 都 fail-closed。
 */
async function activateOwnGeneration(
  processManager: ReturnType<typeof createAgentProcessManager>,
  daemonDir: DaemonDir,
  generationId: string | undefined,
  startTime: ProcessStartTime | undefined,
): Promise<GenerationActivationResult> {
  if (generationId === undefined) {
    return { kind: 'error', reason: 'CHESTNUT_PROCESS_GENERATION env missing' };
  }
  const spawning = processManager.inspectSpawning(daemonDir);
  if (spawning.status !== 'ok') {
    return { kind: 'error', reason: `spawning generation not found: ${spawning.status}` };
  }
  if (spawning.record.generation_id !== generationId) {
    return { kind: 'error', reason: 'spawning generation id mismatch' };
  }
  const pid = processManager.inspectSpawningPid(daemonDir);
  if (pid.status !== 'ok') {
    return { kind: 'error', reason: `spawning pid fact not found: ${pid.status}` };
  }
  if (pid.record.pid !== process.pid) {
    return { kind: 'error', reason: 'spawning pid does not match current process' };
  }
  if (
    startTime !== undefined &&
    pid.record.start_time !== undefined &&
    pid.record.start_time !== startTime
  ) {
    return { kind: 'error', reason: 'spawning startTime mismatch' };
  }
  // Step F barrier：child 在写 ready / activate 前检查是否有绑定本 generation 的 stop intent。
  if (processManager.hasStopIntentForGeneration(daemonDir, generationId)) {
    processManager.retireGeneration(daemonDir, { generationId }, 'stopped', 'spawning');
    return { kind: 'error', reason: 'stop intent recorded before activation' };
  }
  const ready = await processManager.writeGenerationReady(daemonDir, spawning.record, process.pid, startTime);
  if (ready.kind !== 'written') {
    return { kind: 'error', reason: `ready fact write failed: ${ready.kind}` };
  }
  const activation = processManager.activateGeneration(daemonDir, { generationId, pid: process.pid, startTime: startTime as ProcessStartTime | undefined });
  if (activation.kind === 'activated' || activation.kind === 'already_active') {
    return { kind: 'ok', record: activation.record };
  }
  return { kind: 'error', reason: `generation activation failed: ${activation.kind}` };
}
