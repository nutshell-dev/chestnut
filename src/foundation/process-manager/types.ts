import type { FileSystem } from '../fs/index.js';
import type { ProcessManagerAuditSink } from './audit-sink.js';

import type { isAlive as defaultL1IsAlive, spawnDetached as defaultSpawnDetached, getProcessStartTime as defaultGetProcessStartTime, kill as defaultKill } from '../process-exec/index.js';


/**
 * Brand type for daemon owner directory.
 *
 * phase 694: PM API 入参强制 brand、防 structural typing 让 ClawId 当 daemonDir 误传。
 * caller 必经 L4 ClawTopology.resolveClawDaemonDir 或 PM.makeDaemonDir 构造。
 *
 * 同型 brand: ChestnutRoot (foundation/claw-identity/instance-paths.ts) / ClawId (identity/) / StepNumber.
 */
declare const DaemonDirBrand: unique symbol;
export type DaemonDir = string & { readonly [DaemonDirBrand]: true };

/** Brand factory (PM internal 自构造 or L4 ClawTopology 通过本 factory 包) */
export function makeDaemonDir(s: string): DaemonDir {
  return s as DaemonDir;
}


/**
 * Phase 1235: spawn ownership conflict 的合法竞争原因（discriminant）。
 * caller 不解析 message、reason 编译期可检。
 *
 * - active_owner:       active generation 对应进程仍活，磁盘 winner 是 active record
 * - spawn_in_progress:  spawning generation 已被另一 spawn 持有（precheck）
 * - commit_lost:        candidate → spawning move 输给 foreign generation
 */
export type ProcessSpawnConflictReason =
  | 'active_owner'
  | 'spawn_in_progress'
  | 'commit_lost';

/**
 * Phase 1235: 合法 spawn ownership 竞争 —— 另一实例/另一 spawn generation 是
 * 磁盘上的合法 winner。Watchdog 只对本类型清零 restart backoff。
 */
export class ProcessSpawnConflictError extends Error {
  readonly daemonDir: DaemonDir;
  readonly reason: ProcessSpawnConflictReason;
  /** 磁盘 winner 的 generation ID（来源逐分支不同，见 spawn.ts 六分支映射） */
  readonly generationId: string;
  constructor(
    daemonDir: DaemonDir,
    reason: ProcessSpawnConflictReason,
    generationId: string,
    message?: string,
  ) {
    super(message ?? `Spawn conflict for "${daemonDir}" (${reason}, generation ${generationId})`);
    this.name = 'ProcessSpawnConflictError';
    this.daemonDir = daemonDir;
    this.reason = reason;
    this.generationId = generationId;
  }
}

/**
 * Phase 1235: generation 持久状态损坏（malformed）—— fail-closed，不得解释为
 * 另一实例启动成功。携带原始损坏原因（Error cause option），Watchdog 归入
 * failed/backoff 并写 PROCESS_SPAWN_FAILED。
 */
export class ProcessGenerationStateError extends Error {
  readonly daemonDir: DaemonDir;
  readonly location: 'active' | 'spawning';
  readonly operation: 'inspect' | 'commit';
  readonly cause: unknown;
  constructor(
    daemonDir: DaemonDir,
    location: 'active' | 'spawning',
    operation: 'inspect' | 'commit',
    cause: unknown,
    message?: string,
  ) {
    super(
      message ?? `Malformed ${location} generation state for "${daemonDir}" (${operation})`,
    );
    this.name = 'ProcessGenerationStateError';
    this.daemonDir = daemonDir;
    this.location = location;
    this.operation = operation;
    // 显式 readonly 字段保留原始损坏原因（Error cause 语义），不覆盖、不丢失
    this.cause = cause;
  }
}

/**
 * Phase 1282 Step A: `ensureRunning` 的 typed outcome。
 *
 * 区分三种成功路径，调用方不得按 kind 分叉业务逻辑（CLI 只需 ready 事实）；
 * kind 服务于审计与测试断言。
 *
 * - spawned:       本方赢得 spawn ownership 且 child 已 ready
 * - already_ready: precheck 时 active generation 已 ready 且进程存活
 * - joined:        合法 conflict 后等待 foreign winner 至 ready（绑定 exact generation）
 */
export type EnsureRunningOutcome =
  | { kind: 'spawned'; pid: number }
  | { kind: 'already_ready'; pid: number }
  | { kind: 'joined'; pid: number; generationId: string };

/**
 * phase 1769 (Phase 1768 冻结设计): ProcessManager stop 的公开 typed outcome。
 * 穷举四种终局，禁止以 boolean 重新压平（`stop-outcome-boolean-flattened`）：
 * caller 按 discriminant 处理，不再由 boolean 或 audit 反推终局。
 *
 * - stopped:         目标进程已处置（sigterm / sigkill / 已死）且 generation retired
 * - intent_recorded: 目标仍在 spawning 无 PID，immutable intent 已写、parent 会 abort
 * - not_running:     无目标 generation（幂等终局，非失败）
 * - failed:          失败携带 stage（内部阶段不丢失）与原始错误 evidence
 */
export type StopProcessOutcome =
  | { kind: 'stopped'; pid: number; via: 'sigterm' | 'sigkill' | 'already_dead' }
  | { kind: 'intent_recorded' }
  | { kind: 'not_running' }
  | { kind: 'failed'; stage: StopFailureStage; reason: string; error?: unknown };

/**
 * phase 1769: stop 失败的内部阶段（failed outcome 的 discriminant 维度）。
 * 阶段证据必须保留——caller 不得丢失内部阶段/errno（risk 条款）。
 */
export type StopFailureStage =
  | 'target_lookup'    // 初始目标定位失败（malformed generation / slot 被 foreign generation 占据）
  | 'intent_write'     // 持久化 stop intent 失败
  | 'no_pid'           // 目标无 PID 证据（spawning 外路径）
  | 'locate'           // intent 后 / signal 后按 identity 重定位失败（foreign / missing）
  | 'signal'           // kill 或等待过程抛错（error 为原始异常）
  | 'survived_sigkill' // 进程在 SIGKILL 后仍存活
  | 'retire';          // retire 或 retired identity 校验失败

/**
 * phase 1779: orphan cleanup 的 typed outcome（spawn 的 fail-closed gate）。
 * 旧进程重复风险未被证明解除时禁止新 generation spawn（`orphan-cleanup-failure-allows-spawn`）：
 * - clear:      cleanup 已证明完成（terminated = 已 SIGTERM 且 signal 后复核退场的 orphan 数）
 * - not_needed: 无匹配 orphan，无需 cleanup（重复风险不存在）
 * - blocked:    enumerate（process list 不可用）/ signal（SIGTERM 失败）/ verify（signal 后
 *               存活复核失败）——原始 error 与候选 pid evidence 保留，不降级 warning
 */
export type OrphanCleanupResult =
  | { kind: 'clear'; terminated: number }
  | { kind: 'not_needed' }
  | { kind: 'blocked'; stage: OrphanCleanupStage; error: unknown; pids: number[] };

export type OrphanCleanupStage = 'enumerate' | 'signal' | 'verify';

/**
 * phase 1779: orphan cleanup blocked 时 spawn 的 fail-closed typed failure。
 * 原始 error 保留为 cause；候选 pid evidence 保留（caller 按 stage/discriminant 处理，
 * 不解析 message）。
 */
export class ProcessOrphanCleanupError extends Error {
  readonly daemonDir: DaemonDir;
  readonly stage: OrphanCleanupStage;
  readonly pids: readonly number[];
  constructor(
    daemonDir: DaemonDir,
    stage: OrphanCleanupStage,
    error: unknown,
    pids: readonly number[] = [],
    message?: string,
  ) {
    super(
      message ?? `Orphan cleanup for "${daemonDir}" blocked at stage "${stage}" (${pids.length} candidate pid(s) unverified)`,
      { cause: error },
    );
    this.name = 'ProcessOrphanCleanupError';
    this.daemonDir = daemonDir;
    this.stage = stage;
    this.pids = pids;
  }
}

/**
 * phase 1771 (Phase 1770 冻结设计): readiness owner 的公开 typed result。
 * 对外区分 not-ready 与 malformed/read/probe 系统故障，保留原始 evidence；
 * 不得将系统故障重新压平为 not_ready（risk 条款）。
 *
 * - ready:             generation 绑定一致且 liveness probe 存活
 * - not_ready:         正常未就绪（reason 编译期可检）；stale_generation /
 *                      process_not_alive 为冻结设计枚举之外、原 boolean 实现已区分
 *                      的合法未就绪终局，保留不丢证据
 * - malformed:         JSON parse/shape 失败（file + 原始 error）
 * - read_failure:      文件读取失败（非 ENOENT）（file + 原始 error）
 * - probe_unavailable: liveness probe 抛错（原始 error）
 */
export type ReadinessResult =
  | { kind: 'ready'; generationId: string; pid: number }
  | { kind: 'not_ready'; reason: ReadinessNotReadyReason }
  | { kind: 'malformed'; file?: string; error: unknown }
  | { kind: 'read_failure'; file?: string; error: unknown }
  | { kind: 'probe_unavailable'; file?: string; error: unknown };

export type ReadinessNotReadyReason =
  | 'missing_active'
  | 'missing_ready'
  | 'stale_generation'
  | 'process_not_alive';

/**
 * phase 1773 (Phase 1772 冻结设计): liveness owner 的公开 typed result。
 * 对外穷举区分存活/死亡/不存在/证据损坏/probe 系统故障；probe 异常不得伪装
 * alive（risk 条款：probe_unavailable ≠ dead ≠ alive，caller 显式决策）。
 *
 * - alive:             pid 证据完整且 probe 存活
 * - dead:              pid 证据完整但 probe 确认已死（含 ESRCH）；pid/startTime 保留
 * - absent:            无 active generation（missing_active）或有 generation 但无
 *                      pid 事实（missing_pid，crash 窗口）——不同终局不压平
 * - malformed:         磁盘证据损坏（generation.json / pid.json parse/shape/read 失败，
 *                      或 pid 事实与 active generation 身份不匹配）
 * - probe_unavailable: probe 抛非 ESRCH 异常（EPERM/未知错误），error 保留原始 identity
 */
export type LivenessResult =
  | { kind: 'alive'; pid: number; startTime?: string }
  | { kind: 'dead'; pid: number; startTime?: string }
  | { kind: 'absent'; reason: 'missing_active' | 'missing_pid' }
  | { kind: 'malformed'; file: 'generation.json' | 'pid.json'; evidence: unknown }
  | { kind: 'probe_unavailable'; pid: number; error: unknown };

/**
 * Phase 1282 Step A: join foreign winner 收敛失败的 typed reason（discriminant）。
 * caller 不解析 message、reason 编译期可检。
 *
 * - winner_died:              spawning/active 内 winner 进程已死（PID 事实存在但 liveness 失败/ESRCH）
 * - winner_probe_unavailable: phase 1775 新增：probe 系统故障（EPERM/未知错误）≠ winner 死亡；
 *                             原始 error 保留为 cause，caller 不得归类 died（误判 dead → double-spawn）
 * - winner_failed:   winner generation 写了 failure 事实
 * - winner_retired:  winner generation 已被 retire（保留磁盘位置）
 * - winner_replaced: spawning/active slot 被另一 generation 占据；不得跟随新 winner
 * - winner_vanished: winner generation 从所有 slot 消失且未进 retired（异常终局）
 * - join_timeout:    与 spawn 共用的 BOOT_DEADLINE_MS 到期 winner 仍未 ready
 */
export type ProcessWinnerConvergenceReason =
  | 'winner_died'
  | 'winner_probe_unavailable'
  | 'winner_failed'
  | 'winner_retired'
  | 'winner_replaced'
  | 'winner_vanished'
  | 'join_timeout';

/**
 * Phase 1282 Step A: foreign winner 未收敛到 ready 的显式失败。
 *
 * `spawn_in_progress` / `commit_lost` conflict 只证明 winner 取得 ownership，不证明
 * 最终 ready；join 失败必须显式 typed 并保留期望 generation 与磁盘事实位置/原因，
 * 不得静默吞掉或切换跟随未声明的新 winner。
 */
export class ProcessWinnerConvergenceError extends Error {
  readonly daemonDir: DaemonDir;
  readonly reason: ProcessWinnerConvergenceReason;
  /** join 期望的 winner generation ID（来自 ProcessSpawnConflictError.generationId） */
  readonly generationId: string;
  constructor(
    daemonDir: DaemonDir,
    reason: ProcessWinnerConvergenceReason,
    generationId: string,
    message?: string,
    // phase 1775：probe 系统故障等场景保留原始 error identity（evidence），不压进 message 丢失
    options?: { cause?: unknown },
  ) {
    super(message ?? `Winner generation ${generationId} for "${daemonDir}" did not converge to ready (${reason})`, options);
    this.name = 'ProcessWinnerConvergenceError';
    this.daemonDir = daemonDir;
    this.reason = reason;
    this.generationId = generationId;
  }
}

export interface SpawnOptions {
  /** 可执行文件路径（如 'node'） */
  command: string;
  /** 命令参数（如 ['/path/to/daemon-entry.js', 'motion']） */
  args: string[];
  /** 子进程工作目录（可选，默认继承父进程） */
  cwd?: string;
  /** stdout/stderr 重定向的日志文件绝对路径 */
  logFile: string;
  /** 环境变量（可选，默认继承父进程） */
  env?: Record<string, string | undefined>;
}

/**
 * Dependency context for sub-module functions.
 * Replaces class state (this.fs / this.audit).
 *
 * phase 694: 撤 resolveDir callback、PM 不再持 chestnut 拓扑映射；
 * sub-ops 直 take daemonDir: DaemonDir per call。
 */
export interface ProcessManagerContext {
  fs: FileSystem;
  audit: ProcessManagerAuditSink;
  /** Optional ready override (used by tests spying on ProcessManager.prototype.isReady) */
  isReady?: (daemonDir: DaemonDir) => boolean;
  /** Optional l1IsAlive override (used by tests injecting process-exec level liveness probe) */
  l1IsAlive?: typeof defaultL1IsAlive;
  /** Optional spawnDetached override (used by tests injecting process-exec level spawn) */
  spawnDetached?: typeof defaultSpawnDetached;
  /** Optional getProcessStartTime override (used by tests injecting process-exec level startTime probe) */
  getProcessStartTime?: typeof defaultGetProcessStartTime;
  /** Optional kill override (used by tests injecting process-exec level signal sender) */
  kill?: typeof defaultKill;
}
