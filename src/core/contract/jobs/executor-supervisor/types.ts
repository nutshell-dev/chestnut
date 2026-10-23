/**
 * @module L4.ContractSystem.ExecutorSupervisor
 * Phase 1974 Step B: executor-supervisor job 注入面类型。
 *
 * 注入边界（Step A 锁定）：clawTopology / fsFactory / audit / 进程能力
 * （liveness/ensureDaemon/restartDaemon/readHeartbeat）全部由装配期提供；
 * 本 job 不读 ambient CHESTNUT_ROOT、不 import daemon/ProcessManager 实现，
 * 单元测试可完全脱离 ambient。
 */
import type { FileSystem } from '../../../../foundation/fs/index.js';
import type { AuditLog } from '../../../../foundation/audit/index.js';
import type { ClawTopology } from '../../../claw-topology/index.js';
import type { ClawId } from '../../../../foundation/claw-identity/index.js';
import type {
  LivenessResult,
  EnsureRunningOutcome,
  StopProcessOutcome,
} from '../../../../foundation/process-manager/index.js';

/** Daemon 心跳读取结果（装配期把 daemon 协议收窄为本三分 typed result）。 */
export type ExecutorHeartbeatRead =
  | { kind: 'ok'; ts: number }
  | { kind: 'missing' }
  | { kind: 'corrupt' };

/** restartDaemon 的 typed 结果：stop outcome 显式保留（failed 不吞、仍尝试 ensure）。 */
export interface RestartDaemonResult {
  stop: StopProcessOutcome;
  ensured: EnsureRunningOutcome;
}

/** executor-supervisor tick 的全部外部能力（装配期注入）。 */
export interface ExecutorSupervisorDeps {
  /** phase 259 同拓扑注入面（窄化到 enumerate/resolve）。 */
  clawTopology: Pick<ClawTopology, 'enumerate' | 'resolve'>;
  /** motion claw identity（装配期注入；motion daemon 监督归 watchdog，本 job 跳过）。 */
  motionClawId: ClawId;
  /** 装配期 fs 工厂（per-claw baseDir）。 */
  fsFactory: (baseDir: string) => FileSystem;
  audit: Pick<AuditLog, 'write'>;
  /** 进程事实探测（dead/absent/alive/malformed/probe_unavailable）。 */
  liveness: (rawClawId: string) => LivenessResult;
  /** 统一经 ProcessManager.ensureRunning 收敛（不自行 isAlive+spawn，防 double-spawn）。 */
  ensureDaemon: (rawClawId: string) => Promise<EnsureRunningOutcome>;
  /** alive + heartbeat stale 的重启：stop outcome 不吞、失败仍尝试 ensure。 */
  restartDaemon: (rawClawId: string) => Promise<RestartDaemonResult>;
  /** 心跳事实读取（missing/corrupt → unknown 语义，不重启）。 */
  readHeartbeat: (rawClawId: string) => ExecutorHeartbeatRead;
  /** alive-but-loop-stale 判定阈值（config cron.jobs.executor_supervisor）。 */
  heartbeatStaleTimeoutMs: number;
  now?: () => number;
  signal?: AbortSignal;
}
