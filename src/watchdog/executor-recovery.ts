/**
 * @module L6.Watchdog.ExecutorRecovery
 * @layer L6 进程边界（Watchdog 守护进程）
 *
 * Phase 1396 Step F: Watchdog 自有的 claw daemon 可用性恢复闭合。
 *
 * 职责边界：
 * - Watchdog 对**已存在 active generation 事实但当前进程死亡**、或**进程存活但心跳过期**
 *   （alive-but-loop-stale，Phase 1878 Step B）的 claw daemon 执行重启；
 *   clean-stop marker 存在时视为用户主动停止，不重启。
 * - 复用 motion restart 的 reducer（executor-neutral 化），保持现有 max attempts / backoff。
 * - 每次 outcome 持久化到 Watchdog state；重启成功清除 attempt/circuit。
 * - circuit-open 先写 terminal evidence，再经 Step D narrow sink 报告
 *   `{executorId, producer:'watchdog', reason:'daemon_unavailable', evidenceRef}`；
 *   sink 失败保留 evidence，下 tick 只重试交付，不再 spawn。
 * - Watchdog 不查询 contract 状态；sink 只带 executorId，ContractSystem 自行映射 active contract。
 *
 * Phase 1878 Step B：心跳监督闭环——Daemon 稳定心跳协议（`daemon/heartbeat.json`，
 * 见 daemon/heartbeat-fact.ts）由本模块单向消费：进程 alive 且心跳过期 → 走同一
 * restart machinery（退避/熔断语义复用，审计事件区分 stale vs dead）；心跳缺失
 * （旧版本升级窗口）/ 读取损坏 → 显式 unknown（audit、不重启、不误判）。
 */

import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { isFileNotFound } from '../foundation/fs/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { createDirContext } from '../foundation/audit/index.js';
import type { ProcessManager } from '../foundation/process-manager/index.js';
import { ProcessSpawnConflictError, hasCleanStopIntent } from '../foundation/process-manager/index.js';
import { PROCESS_MANAGER_AUDIT_EVENTS } from '../foundation/process-manager/index.js';
import { makeClawId } from '../foundation/claw-identity/index.js';
import { getClawDir, enumerateClaws } from '../foundation/claw-identity/index.js';
import { resolveClawDaemonDir } from '../core/claw-topology/index.js';
import { createExecutionFailureSink } from '../core/contract/index.js';
import type { ExecutionFailureSink } from '../core/contract/index.js';
import { createDaemonSpawnOptions, readDaemonHeartbeat } from '../daemon/index.js';
import { getWorkspaceRoot } from '../foundation/claw-identity/index.js';
import {
  getChestnutFs,
  type MotionRestartState,
  type ExecutorRestartMap,
  type ExecutorRestartState,
} from './watchdog-context.js';
import {
  decideMotionRestart as decideExecutorRestart,
  reduceMotionRestartOutcome as reduceExecutorRestartOutcome,
  type MotionSpawnOutcome as ExecutorSpawnOutcome,
} from './motion-restart-state.js';
import { WATCHDOG_AUDIT_EVENTS } from './audit-events.js';
import { HEARTBEAT_STALE_TIMEOUT_MS } from './constants.js';
import { quarantineCorruptFile } from './quarantine.js';
import { log } from './watchdog-log.js';

/** circuit-open 阶段终端 evidence schema（chestnut root 相对路径）。 */
export const EXECUTOR_RECOVERY_EVIDENCE_DIR = 'watchdog/executor-recovery';

/** Terminal evidence persisted by Watchdog before delivering daemon_unavailable. */
interface ExecutorRecoveryEvidence {
  schema_version: 1;
  executorId: string;
  consecutiveAttempts: number;
  openedAt: number;
  lastError?: string;
  /** sink 交付成功后 true；失败/未交付时 undefined/false。 */
  sinkDelivered?: boolean;
}

/** 默认最大重启尝试次数，与 motion restart 同值（复用 WATCHDOG_MAX_RESTART_DEFAULT）。 */
const EXECUTOR_MAX_RESTART_DEFAULT = 10;

/** 默认检查间隔（30s），与 motion restart 同值。 */
const EXECUTOR_BASE_INTERVAL_MS = 30_000;

/** 指数退避 cap，与 motion restart 同值。 */
const EXECUTOR_BACKOFF_MAX_MS = 5 * 60 * 1000;

function getExecutorMaxRestart(): number {
  const raw = process.env.WATCHDOG_MAX_RESTART;
  if (!raw) return EXECUTOR_MAX_RESTART_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : EXECUTOR_MAX_RESTART_DEFAULT;
}

function evidencePath(rawClawId: string): string {
  return path.join(EXECUTOR_RECOVERY_EVIDENCE_DIR, `${rawClawId}.json`);
}

function evidenceRef(rawClawId: string): string {
  return `${EXECUTOR_RECOVERY_EVIDENCE_DIR}/${rawClawId}.json`;
}

/** 读取分层（Phase 1878 Step F）：found / absent（ENOENT）/ corrupt（parse/schema）。
 * IO 错误（非 ENOENT 读取失败）原样传播——不折 null、不误判。 */
type EvidenceRead =
  | { kind: 'found'; evidence: ExecutorRecoveryEvidence }
  | { kind: 'absent' }
  | { kind: 'corrupt'; error: string };

function readEvidence(rootFs: FileSystem, rawClawId: string): EvidenceRead {
  const raw = rootFs.readSync(evidencePath(rawClawId)); // ENOENT/IO 错由下方分类/上抛
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'corrupt', error: `JSON parse failed: ${formatErr(err)}` };
  }
  const candidate = parsed as Partial<ExecutorRecoveryEvidence> | null;
  if (
    candidate
    && typeof candidate === 'object'
    && candidate.schema_version === 1
    && typeof candidate.executorId === 'string'
    && typeof candidate.consecutiveAttempts === 'number'
    && typeof candidate.openedAt === 'number'
  ) {
    return { kind: 'found', evidence: candidate as ExecutorRecoveryEvidence };
  }
  return { kind: 'corrupt', error: 'schema mismatch' };
}

/** 读取封装：ENOENT → absent；非 ENOENT IO 错原样传播。 */
function readEvidenceLayered(rootFs: FileSystem, rawClawId: string): EvidenceRead {
  try {
    return readEvidence(rootFs, rawClawId);
  } catch (err) {
    if (isFileNotFound(err)) return { kind: 'absent' };
    throw err;
  }
}

function writeEvidence(rootFs: FileSystem, evidence: ExecutorRecoveryEvidence): void {
  rootFs.ensureDirSync(EXECUTOR_RECOVERY_EVIDENCE_DIR);
  rootFs.writeAtomicSync(evidencePath(evidence.executorId), JSON.stringify(evidence));
}

function deleteEvidence(rootFs: FileSystem, rawClawId: string): void {
  try {
    rootFs.deleteSync(evidencePath(rawClawId));
  } catch (e) {
    if (!isFileNotFound(e)) throw e;
  }
}

/**
 * Phase 1878 Step D: 消费 ContractSystem 窄 ExecutionFailureSink capability——
 * 不再每交付构造完整 ContractSystem / ToolRegistry（语义 1:1 同一实现源）。
 * claw audit 归 caller scope：每次交付创建并对称 dispose（防短缓冲丢失）。
 */
function makeContractFailureSink(
  fsFactory: (baseDir: string) => FileSystem,
  rawClawId: string,
): ExecutionFailureSink {
  const clawDir = getClawDir(rawClawId);
  const { fs, audit } = createDirContext({ fsFactory }, clawDir);
  const sink = createExecutionFailureSink({
    fs,
    audit,
    clawDir,
    clawId: makeClawId(rawClawId),
  });
  return {
    report: async (input) => {
      try {
        return await sink.report(input);
      } finally {
        audit.dispose?.();
      }
    },
  };
}

/** Deps for maybeCronExecutorRecovery. */
interface ExecutorRecoveryDeps {
  pm: ProcessManager;
  audit: AuditLog;
  fsFactory: (baseDir: string) => FileSystem;
  /** 注入点：测试替代真实 spawn。 */
  spawnDaemon?: (rawClawId: string) => Promise<ExecutorSpawnOutcome>;
  /** 注入点：测试替代真实 ContractSystem sink。 */
  makeFailureSink?: (rawClawId: string) => ExecutionFailureSink;
  /** 当前时间注入点。 */
  now?: () => number;
  /** 最大重启尝试次数（默认 10）。 */
  maxAttempts?: number;
  /** 检查间隔（baseIntervalMs，默认 30000）。 */
  baseIntervalMs?: number;
  /** 指数退避 cap（默认 5min）。 */
  maxBackoffMs?: number;
  /**
   * alive-but-loop-stale 判定阈值（默认 HEARTBEAT_STALE_TIMEOUT_MS）。
   * Phase 1878 Step C 起由 config `heartbeat_stale_timeout_ms` 注入。
   */
  heartbeatStaleTimeoutMs?: number;
}

export async function maybeCronExecutorRecovery(
  stateMap: ExecutorRestartMap,
  deps: ExecutorRecoveryDeps,
): Promise<ExecutorRestartMap> {
  const {
    pm, audit, fsFactory,
  } = deps;
  const now = deps.now ?? (() => Date.now());
  const maxAttempts = deps.maxAttempts ?? getExecutorMaxRestart();
  const baseIntervalMs = deps.baseIntervalMs ?? EXECUTOR_BASE_INTERVAL_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? EXECUTOR_BACKOFF_MAX_MS;
  const heartbeatStaleTimeoutMs = deps.heartbeatStaleTimeoutMs ?? HEARTBEAT_STALE_TIMEOUT_MS;
  const rootFs = getChestnutFs(fsFactory);

  const nextMap: ExecutorRestartMap = { ...stateMap };

  let clawNames: string[];
  try {
    clawNames = enumerateClaws(rootFs, 'claws');
  } catch (err) {
    if (isFileNotFound(err)) return nextMap;
    audit.write(
      WATCHDOG_AUDIT_EVENTS.CLAWS_DIR_LIST_FAILED,
      `ctx=executor_recovery`,
      `dir=claws`,
      `error=${formatErr(err)}`,
    );
    return nextMap;
  }

  audit.write(
    WATCHDOG_AUDIT_EVENTS.CLAW_SCAN,
    `ctx=executor_recovery`,
    `present=${clawNames.join(',')}`,
  );

  for (const rawClawId of clawNames) {
    const clawId = makeClawId(rawClawId);
    const daemonDir = resolveClawDaemonDir(clawId);
    const status = pm.liveness(daemonDir);

    // Phase 1878 Step B: alive 进程额外查心跳事实——alive ∧ 心跳过期 = loop-stale，
    // 与 dead 同走 restart machinery；missing/corrupt → unknown（不重启、不误判）。
    let executorDown = status.kind === 'dead';
    if (status.kind === 'alive') {
      const heartbeat = readDaemonHeartbeat(fsFactory(getClawDir(rawClawId)));
      if (heartbeat.kind === 'missing' || heartbeat.kind === 'corrupt') {
        // 升级窗口（旧 daemon 无心跳文件）/ 读取损坏 → 显式 unknown：
        // 不重启（防误杀）、不阻断现有 alive 清理语义。
        audit.write(
          WATCHDOG_AUDIT_EVENTS.EXECUTOR_HEARTBEAT_UNKNOWN,
          `claw=${rawClawId}`,
          `reason=heartbeat_${heartbeat.kind}`,
          ...(heartbeat.kind === 'corrupt' ? [`error=${heartbeat.error}`] : []),
        );
      } else if (now() - heartbeat.fact.ts > heartbeatStaleTimeoutMs) {
        executorDown = true;
        audit.write(
          WATCHDOG_AUDIT_EVENTS.EXECUTOR_HEARTBEAT_STALE,
          `claw=${rawClawId}`,
          `heartbeat_ts=${heartbeat.fact.ts}`,
          `now=${now()}`,
          `stale_timeout_ms=${heartbeatStaleTimeoutMs}`,
          `pm=alive`,
        );
      }
      if (!executorDown) {
        // 恢复存活：清 attempt/circuit + 删 evidence。
        if (nextMap[rawClawId]?.status !== 'closed') {
          audit.write(
            WATCHDOG_AUDIT_EVENTS.WATCHDOG_CIRCUIT_REOPENED,
            `claw=${rawClawId}`,
            `reason=executor_alive_again`,
            `prev_failures=${nextMap[rawClawId]?.consecutiveAttempts ?? 0}`,
          );
          delete nextMap[rawClawId];
          deleteEvidence(rootFs, rawClawId);
        }
        continue;
      }
    }

    const clawDir = getClawDir(rawClawId);
    const clawFs = fsFactory(clawDir);
    // Phase 1878 Step E: clean-stop 意图经 PM 稳定查询读取（路径知识归 PM owner）。
    const cleanStop = hasCleanStopIntent(clawFs, daemonDir);
    if (cleanStop) {
      // 用户主动 stop：不视为需要恢复；清状态防止残留。
      if (nextMap[rawClawId]) {
        audit.write(
          WATCHDOG_AUDIT_EVENTS.EXECUTOR_RECOVERY_SKIPPED,
          `claw=${rawClawId}`,
          `reason=clean_stop_marker`,
        );
        delete nextMap[rawClawId];
        deleteEvidence(rootFs, rawClawId);
      }
      continue;
    }

    // phase 1773: 只恢复 probe 确认已死（dead）的 daemon——absent（从未启动/已退役）、
    // malformed（证据损坏）、probe_unavailable（probe 系统故障）均不恢复；
    // probe_unavailable ≠ dead，误判会 double-spawn（frozen 设计 risk 条款）。
    // Phase 1878 Step B: alive-but-loop-stale（executorDown）同走 restart machinery。
    if (!executorDown) {
      continue;
    }

    let state: ExecutorRestartState = nextMap[rawClawId] ?? { status: 'closed', consecutiveAttempts: 0 };
    const decision = decideExecutorRestart(state as MotionRestartState, false, now(), maxAttempts);
    state = decision.state as ExecutorRestartState;

    switch (decision.action) {
      case 'healthy': {
        // 理论上 unreachable（status.alive=false 时 decision 不会 healthy），防御性保留。
        break;
      }
      case 'defer': {
        const retrying = state as Extract<typeof state, { status: 'retrying' }>;
        audit.write(
          WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_DEFERRED,
          `claw=${rawClawId}`,
          `consecutive_attempts=${retrying.consecutiveAttempts}`,
          `next_attempt_at=${retrying.nextAttemptAt}`,
        );
        break;
      }
      case 'circuit_open': {
        const openState: Extract<ExecutorRestartState, { status: 'open' }> = {
          ...state,
          status: 'open',
          consecutiveAttempts: state.consecutiveAttempts,
          openedAt: state.status === 'open'
            ? (state as Extract<ExecutorRestartState, { status: 'open' }>).openedAt
            : now(),
          sinkDelivered: state.status === 'open'
            ? (state as Extract<ExecutorRestartState, { status: 'open' }>).sinkDelivered ?? false
            : false,
        };
        if (decision.justOpened) {
          audit.write(
            WATCHDOG_AUDIT_EVENTS.WATCHDOG_GAVE_UP,
            `claw=${rawClawId}`,
            `consecutive_failures=${openState.consecutiveAttempts}`,
            `cap=${maxAttempts}`,
            `reason=executor_restart_unstable`,
          );
          const evidence: ExecutorRecoveryEvidence = {
            schema_version: 1,
            executorId: rawClawId,
            consecutiveAttempts: openState.consecutiveAttempts,
            openedAt: openState.openedAt,
          };
          writeEvidence(rootFs, evidence);
        }
        // circuit-open 后先尝试交付；已交付成功则跳过。
        if (!openState.sinkDelivered) {
          const sink = deps.makeFailureSink
            ? deps.makeFailureSink(rawClawId)
            : makeContractFailureSink(fsFactory, rawClawId);
          try {
            // Phase 1803 Step B: 穷尽处理三态 ack——committed 交付闭合
            // （terminal winner 已确定）；retryable 保留证据下 tick 重试；
            // rejected 是永久拒绝（identity mismatch 等），保留证据并以独立
            // audit 上抛（下 tick 重报保持可观测）。意外 throw 走 catch 兜底。
            const outcome = await sink.report({
              executorId: rawClawId,
              producer: 'watchdog',
              reason: 'daemon_unavailable',
              evidenceRef: evidenceRef(rawClawId),
            });
            switch (outcome.kind) {
              case 'committed': {
                openState.sinkDelivered = true;
                // Phase 1878 Step F: 读取分层——found 原位更新 delivered 标记；
                // corrupt 显式隔离（原文保留）+ audit + 显式重建 delivered 证据；
                // absent 不写（零漂移）。不再静默折 null。
                const read = readEvidenceLayered(rootFs, rawClawId);
                if (read.kind === 'found') {
                  writeEvidence(rootFs, { ...read.evidence, sinkDelivered: true });
                } else if (read.kind === 'corrupt') {
                  const quarantine = quarantineCorruptFile(rootFs, evidencePath(rawClawId), now());
                  audit.write(
                    WATCHDOG_AUDIT_EVENTS.EXECUTOR_RECOVERY_EVIDENCE_CORRUPT,
                    `claw=${rawClawId}`,
                    `path=${evidenceRef(rawClawId)}`,
                    `quarantine=${quarantine.backupPath}`,
                    `quarantine_ok=${quarantine.kind === 'quarantined'}`,
                    ...(quarantine.kind === 'failed' ? [`quarantine_error=${quarantine.error}`] : []),
                    `reason=${read.error}`,
                  );
                  // 显式重建语义：本轮交付已确认 committed → 自 openState 事实
                  // 重建 delivered 终态证据（交付决策可重建，不静默覆盖）。
                  writeEvidence(rootFs, {
                    schema_version: 1,
                    executorId: rawClawId,
                    consecutiveAttempts: openState.consecutiveAttempts,
                    openedAt: openState.openedAt,
                    sinkDelivered: true,
                  });
                }
                audit.write(
                  WATCHDOG_AUDIT_EVENTS.EXECUTOR_UNAVAILABLE_DELIVERED,
                  `claw=${rawClawId}`,
                  `attempts=${openState.consecutiveAttempts}`,
                );
                break;
              }
              case 'retryable':
                audit.write(
                  WATCHDOG_AUDIT_EVENTS.EXECUTOR_UNAVAILABLE_DELIVERY_FAILED,
                  `claw=${rawClawId}`,
                  `reason=${outcome.error}`,
                );
                break;
              case 'rejected':
                audit.write(
                  WATCHDOG_AUDIT_EVENTS.EXECUTOR_UNAVAILABLE_DELIVERY_REJECTED,
                  `claw=${rawClawId}`,
                  `reason=${outcome.reason}`,
                );
                break;
            }
          } catch (err) {
            audit.write(
              WATCHDOG_AUDIT_EVENTS.EXECUTOR_UNAVAILABLE_DELIVERY_FAILED,
              `claw=${rawClawId}`,
              `reason=${formatErr(err)}`,
            );
          }
        }
        state = openState;
        break;
      }
      case 'attempt': {
        const outcome = await (async (): Promise<ExecutorSpawnOutcome> => {
          try {
            return deps.spawnDaemon
              ? await deps.spawnDaemon(rawClawId)
              : await defaultSpawnClawDaemon(pm, fsFactory, rawClawId);
          } catch (error) {
          // silent: spawn failure is converted to a typed outcome and audited below
          return { kind: 'failed', error };
        }
        })();
        state = reduceExecutorRestartOutcome(
          state as MotionRestartState,
          outcome,
          now(),
          baseIntervalMs,
          maxBackoffMs,
        ) as ExecutorRestartState;
        if (outcome.kind === 'spawned') {
          audit.write(PROCESS_MANAGER_AUDIT_EVENTS.PROCESS_SPAWNED, `claw=${rawClawId}`, `pid=${outcome.pid}`);
          log(fsFactory, `[watchdog] claw ${rawClawId} restarted (PID=${outcome.pid})`);
        } else if (outcome.kind === 'spawn_conflict') {
          audit.write(
            WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED,
            `claw=${rawClawId}`,
            `reason=spawn_conflict_winner`,
          );
        } else {
          audit.write(
            WATCHDOG_AUDIT_EVENTS.WATCHDOG_RESTART_TRIGGERED,
            `claw=${rawClawId}`,
            `reason=${formatErr(outcome.error)}`,
          );
        }
        break;
      }
    }

    if (state.status === 'closed' && state.consecutiveAttempts === 0) {
      delete nextMap[rawClawId];
      deleteEvidence(rootFs, rawClawId);
    } else {
      nextMap[rawClawId] = state;
    }
  }

  return nextMap;
}

async function defaultSpawnClawDaemon(
  pm: ProcessManager,
  fsFactory: (baseDir: string) => FileSystem,
  rawClawId: string,
): Promise<ExecutorSpawnOutcome> {
  try {
    const clawId = makeClawId(rawClawId);
    const daemonDir = resolveClawDaemonDir(clawId);
    // best-effort cleanup stale generation before respawn；失败不阻塞（同 motion restart 模式）
    await pm.stop(daemonDir).catch((e) => {
      log(fsFactory, `[watchdog] Failed to clean up claw ${rawClawId} before restart: ${formatErr(e)}`);
    });
    // Phase 1464 Step B: spawn specification 归 Daemon 唯一 owner（含 log/env/cwd 协议）；
    // phase 444 daemonLogName DI 随本 capability 退役（watchdog→daemon 合法单边已由
    // phase 1284/1343 ratify，log 路径协议收进 createDaemonSpawnOptions）
    const pid = await pm.spawn(daemonDir, createDaemonSpawnOptions({
      clawId,
      agentDir: getClawDir(rawClawId),
      workspaceRoot: getWorkspaceRoot(),
    }));
    return { kind: 'spawned', pid };
  } catch (err) {
    if (err instanceof ProcessSpawnConflictError) {
      return { kind: 'spawn_conflict', reason: err.reason };
    }
    return { kind: 'failed', error: err };
  }
}


