/**
 * @module L4.ContractSystem.ExecutionFailure
 *
 * Phase 1878 Step D（watchdog-contract-sink-overassembly）：`ExecutionFailureSink`
 * 窄能力提供面——消费方（Watchdog executor-recovery）不再为每次交付构造完整
 * ContractSystem（含 ToolRegistry / notifyClaw / bootReconcile 等无关装配）。
 *
 * 结构（语义 1:1 零漂移）：
 * - `failActiveContractsForExecutor`：`ContractSystem.failActiveForExecutor` 的
 *   语义本体（executor mismatch 拒绝 + active 枚举 + intent/rename winner 协议 +
 *   三态 ack 聚合），manager 委托本函数（单一实现源）。
 * - `createExecutionFailureSink`：最小依赖面工厂（fs + audit + clawDir + clawId），
 *   返回 `ExecutionFailureSink`。本进程无 in-memory verifier controller（verifier
 *   存活在 daemon 进程），`abortContractVerifiers` 为空操作——与此前 Watchdog
 *   每次构造的全新 ContractSystem（空 controller map）行为完全一致。
 *
 * 生命周期：sink 不持有 handle/timer；audit 由 caller scope 创建并 dispose
 * （owner 工厂不 own 外部资源）。
 */
import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { sha256Hex } from '../../foundation/node-utils/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { listPhysicalActiveContractIds } from './locations.js';
import { failContract, type TerminalLifecycleContext, type TerminalTransitionOutcome } from './lifecycle.js';
import { CONTRACT_ACTIVE_DIR, CONTRACT_ARCHIVE_DIR } from './dirs.js';
import { makeArchiveDir } from './types.js';
import type {
  ContractExecutionFailure,
  ContractId,
  ExecutionFailureReportOutcome,
  ExecutionFailureSink,
} from './types.js';
import type { ContractNotificationSink } from './notification.js';

/** failActiveForExecutor 语义本体依赖面（manager 与窄 sink 共用）。 */
export interface ExecutionFailureReportDeps {
  fs: FileSystem;
  audit: AuditLog;
  /** clawDir（lifecycle intent stable store 的 baseDir）。 */
  clawDir: string;
  /** 本 ContractSystem 所属 executor identity（mismatch 拒绝判定）。 */
  clawId: ClawId;
  /** 终态 commit 后的 verifier abort 传播（无 in-memory verifier 的进程传空操作）。 */
  abortContractVerifiers: (contractId: ContractId, reason: string) => void;
  /** 终态事件通知 sink（可选；无 sink = 无外推）。 */
  onNotify?: ContractNotificationSink;
  /**
   * 每个 contract 终态 transition 完成后的清理钩子（manager 用于清 auditorState；
   * 窄 sink 无 auditorState，不传）。
   */
  onTerminalSettled?: (contractId: ContractId) => void;
}

/**
 * Phase 1398 Step B: 稳定 requestId 派生。输入全部是已有持久事实
 * （contractId + executorId + producer + reason + evidenceRef），字段顺序固定；
 * 不使用 Date.now() 或随机数，at-least-once 重试复用同一 lifecycle intent。
 */
function executionFailureRequestId(
  contractId: ContractId,
  input: ContractExecutionFailure,
): string {
  return `execution-failure-${sha256Hex(JSON.stringify([
    contractId,
    input.executorId,
    input.failure.producer,
    input.failure.reason,
    input.failure.evidenceRef,
  ]))}`;
}

/**
 * fail all active contracts owned by this executor（语义本体，manager 委托）。
 *
 * ContractSystem 自己枚举/核实 active contract（按 sorted id deterministic
 * 顺序逐个走 fail 的 intent + rename winner 协议）；调用者只传 executor
 * identity + failure fact，不得传 contract 路径或执行 rename。executorId 与
 * 本 claw 不一致时拒绝并留 audit（下层不得跨边界改写别的 executor 的资源）。
 *
 * 三态 ack（Phase 1803 Step B）：terminal winner 已确定（committed /
 * already_committed / lost_to_state）或无 active contract → committed；
 * 任一 contract 本轮 retryable → retryable{error}（单个 retryable 不阻断本轮
 * 其他 active contract）；executor mismatch → rejected{reason}。相同
 * contract + executor + producer + reason + evidenceRef 派生稳定 requestId。
 * 意外异常（fs 故障等）仍以 rejection 上抛，不并入 outcome。
 */
export async function failActiveContractsForExecutor(
  deps: ExecutionFailureReportDeps,
  input: ContractExecutionFailure,
): Promise<ExecutionFailureReportOutcome> {
  if (input.executorId !== deps.clawId) {
    deps.audit.write(
      CONTRACT_AUDIT_EVENTS.FAIL_EXECUTOR_MISMATCH,
      `executorId=${input.executorId}`,
      `clawId=${deps.clawId}`,
      `producer=${input.failure.producer}`,
    );
    return {
      kind: 'rejected',
      reason: `Execution failure report rejected: executor "${input.executorId}" does not own this ContractSystem (claw "${deps.clawId}")`,
    };
  }

  const lifecycleCtx: TerminalLifecycleContext = {
    fs: deps.fs,
    audit: deps.audit,
    baseDir: deps.clawDir,
    activeDir: CONTRACT_ACTIVE_DIR,
    archiveDir: makeArchiveDir(CONTRACT_ARCHIVE_DIR),
    abortContractVerifiers: deps.abortContractVerifiers,
    onNotify: deps.onNotify,
  };

  const activeIds = await listPhysicalActiveContractIds({
    fs: deps.fs,
    activeDir: CONTRACT_ACTIVE_DIR,
  });

  let retryable: TerminalTransitionOutcome | null = null;
  for (const contractId of activeIds) {
    const outcome = await failContract(
      lifecycleCtx,
      contractId,
      input.failure,
      executionFailureRequestId(contractId, input),
    );
    deps.onTerminalSettled?.(contractId);
    // 单个 retryable 只记录本轮未闭合，不阻断其他 active contract。
    if (outcome.commit.kind === 'retryable_failure' && retryable === null) {
      retryable = outcome;
    }
  }
  if (retryable !== null) {
    const commit = retryable.commit;
    return {
      kind: 'retryable',
      error: `Execution failure not closed this round: ${commit.kind === 'retryable_failure' ? commit.cause : 'unknown'}`,
    };
  }
  return { kind: 'committed' };
}

/** createExecutionFailureSink 最小依赖面。 */
export interface ExecutionFailureSinkDeps {
  fs: FileSystem;
  audit: AuditLog;
  clawDir: string;
  clawId: ClawId;
  onNotify?: ContractNotificationSink;
}

/**
 * ExecutionFailureSink 窄能力工厂（Phase 1878 Step D）：不构造完整
 * ContractSystem 实例。语义与 `ContractSystem.failActiveForExecutor` 1:1
 * （同一实现源 failActiveContractsForExecutor）。
 *
 * `abortContractVerifiers` 空操作：本 sink 面向跨进程报告方（如 Watchdog），
 * 进程内无 verifier controller 可 abort——与此前每次构造全新 ContractSystem
 * （空 controller map）的行为一致；被 fail 的 contract 所属 daemon 进程已死或
 * 停滞，其 verifier 随进程收束。
 */
export function createExecutionFailureSink(deps: ExecutionFailureSinkDeps): ExecutionFailureSink {
  return {
    report: (input) =>
      failActiveContractsForExecutor(
        {
          fs: deps.fs,
          audit: deps.audit,
          clawDir: deps.clawDir,
          clawId: deps.clawId,
          abortContractVerifiers: () => undefined,
          onNotify: deps.onNotify,
        },
        {
          executorId: input.executorId,
          failure: {
            reason: input.reason,
            evidenceRef: input.evidenceRef,
            producer: input.producer,
          },
        },
      ),
  };
}
