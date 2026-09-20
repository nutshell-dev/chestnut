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
import { createSystemAudit, type AuditLog, AUDIT_FILE } from '../foundation/audit/index.js';
import { summarizeLastExit } from './last-exit-summary.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import { getProcessStartTime, type ProcessStartTime } from '../foundation/process-exec/index.js';
import { createInboxReader } from '../foundation/messaging/index.js';
import type { FileSystem } from '../foundation/fs/index.js';

import { DAEMON_AUDIT_EVENTS } from './audit-events.js';
import { CLAW_SPEC_FILE } from '../foundation/claw-identity/index.js';
import type { AssembleConfig, Instances } from '../assembly/index.js';
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
  /** phase 1873 Step F: 内层 graceful handler 就绪后 shim 让位（entry 注入；缺省无 shim）。 */
  shimStandDown?: () => void;
  auditEvents: {
    /** 装配内部失败（Assembly owner）。 */
    assembleFailed: string;
    /** phase 1873 Step J: 装配后、进入驱动前的进程生命周期失败（Daemon owner，携 stage）。 */
    preRuntimeFailed: string;
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
        // phase 1873 Step J: 进程生命周期失败（Daemon owner），与装配内部失败可区分。
        preAssembleAudit.write(deps.auditEvents.preRuntimeFailed, 'stage=claw_config', 'phase=preconstruct', `reason=${reason}`);
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

    const { runtime, snapshot, auditWriter, heartbeat, eventLoop } = instances;

    // Phase 1204 Step C（phase 1873 Step B：协议归 PM capability）：child 激活
    // generation——inspect/比对/stop-intent/ready/activate 由 PM 完成，Daemon 只消费 outcome。
    let generationRecord: ProcessGenerationRecord | undefined;
    /**
     * phase 1873 Step D（daemon-post-assemble-failure-leaks-session）：获得 Instances
     * 后的任意启动失败统一收束——audit 留证 → dispose session（次生失败 audit）→
     * 收束 generation（retire）→ flush audit → exit(1)。不再裸 exit 弃置已装配资源。
     * 与 1872 C 装配期 rollback 不重叠：此处处理的是装配成功后（Instances 已提交）的失败。
     */
    const failAfterAssemble = async (
      where: { module: string; phase: string },
      e: unknown,
    ): Promise<void> => {
      auditWriter.write(deps.auditEvents.preRuntimeFailed, `stage=${where.module}`, `phase=${where.phase}`, `reason=${formatErr(e)}`);
      try {
        await instances.dispose(`post_assemble_failure:${where.module}`);
      } catch (secondary) {
        auditWriter.write(deps.auditEvents.preRuntimeFailed, 'stage=post_assemble_dispose', 'phase=teardown', `reason=${formatErr(secondary)}`);
      }
      try {
        if (generationRecord) {
          instances.processManager.retireGeneration(daemonDir, { generationId: generationRecord.generation_id }, 'shutdown', 'active');
        }
      } catch (retireErr) {
        auditWriter.write(deps.auditEvents.preRuntimeFailed, 'stage=post_assemble_retire', 'phase=teardown', `reason=${formatErr(retireErr)}`);
      }
      auditWriter.dispose?.();
      process.exit(1);
    };

    try {
      const startTime = getProcessStartTime(process.pid) as ProcessStartTime | undefined;
      const activationResult = await instances.processManager.activateChildGeneration(daemonDir, {
        generationId: processGenerationId,
        pid: process.pid,
        startTime,
      });
      if (activationResult.kind !== 'activated') {
        throw new Error(activationResult.reason);
      }
      generationRecord = activationResult.record;
    } catch (e) {
      // phase 1873 Step D: 收束后再退出（此窗口 generationRecord 未建立 → 无 retire 分支）。
      await failAfterAssemble({ module: 'generation_activation', phase: 'post_assemble' }, e);
      return;
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

    // phase 1873 Step C: EventLoop 构造/初始化归 Assembly（instances.eventLoop 已就绪）；
    // daemon 只驱动（run/abort）。

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
      // phase 1873 Step D: dispose + retire 后再退出（不再裸 exit 弃置 session）。
      await failAfterAssemble({ module: 'runtime', phase: 'post_assemble_init' }, e);
      return;
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
    // phase 1873 Step E（daemon-audit-session-not-disposed）：preAssemble 审计职责段
    // 到此结束（业务已转入主 auditWriter）——成功路径同错误路径对称 dispose（flush）。
    preAssembleAudit.dispose?.();

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
      // phase 1873 Step I: fatal 恢复预算耗尽 → 走既有 teardown 语义（gracefulShutdown
      // 的 dispose→retire 链）后退出，交 Watchdog 重启接管。
      onFatalExhausted: async () => {
        await gracefulShutdown('loop_fatal_exhausted', 5_000);
        auditWriter.dispose?.();
        process.exit(1);
      },
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
    // phase 1873 Step F: 内层 graceful handler 已就绪（含 dispose→retire→exit 链）——
    // shim 让位（移除自身监听 + dispose shimAudit）；此后未捕获错误走内层、不再被 harsh exit 截断。
    deps.shimStandDown?.();

    // shutdown (SIGTERM/SIGINT)
    const shutdown = async (signal: string): Promise<void> => {
      if (!beginShutdown(signal)) return;  // phase 1124: 重入抑制、首个继续
      await gracefulShutdown(signal, 30_000);
      // phase 1873 Step E: 主 auditWriter 在 exit(0) 前 dispose（flush；与 crash 路径同型）。
      auditWriter.dispose?.();
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

