/**
 * @module L5.EventLoop.ExecutionRecovery
 * @layer L5 服务层
 * @depends L2.AuditLog, L2.Fs, L2.Stream
 * @consumers L5.EventLoop, L6.Assembly
 *
 * Phase 1396 Step E: EventLoop 自有的执行停滞恢复闭合。
 *
 * 职责边界：
 * - EventLoop 判断活进程中的 agent 执行是否自发停滞（无 turn/retry/task 在途、
 *   active contract 存在、持久 activity 超时），先本模块自恢复（向自身 inbox 写
 *   高优 resume event，正常 drain 消费，不调 Runtime reentrant API）；
 * - 恢复尝试耗尽后只通过 Step D narrow sink 报告 `{executorId, producer, reason,
 *   evidenceRef}`；不直接改 contract、不通知 motion；
 * - recovery state 全落盘（`.chestnut/event-loop/execution-recovery/<contractId>.json`），
 *   daemon 重启后从 record 恢复 attempt 计数与交付义务。
 *
 * 持久事实约束（计划 §10 风险）：`lastActivityAt` 必须来自 Stream/Contract 已持久
 * 事实，不得用内存 timer；恢复消息自身不产生 stream LLM output，天然不算业务
 * progress，不会永远重置计数。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { readAll, STREAM_FILE, LLM_OUTPUT_EVENTS } from '../../foundation/stream/index.js';
import { EXECUTION_RECOVERY_DIR } from './constants.js';
import { EVENTLOOP_AUDIT_EVENTS } from './audit-events.js';

/** 最大恢复尝试次数，只在本模块定义（计划 §4）。 */
export const MAX_EXECUTION_RECOVERY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Record schema
// ---------------------------------------------------------------------------

export interface ExecutionRecoveryRecord {
  schema_version: 1;
  contractId: string;
  /** 本 recovery epoch 观察到的最后一次持久 activity（epoch ms）。 */
  observedActivityAt: number;
  /** 已消费的恢复尝试次数（1-based 累计）。 */
  attempts: number;
  /** 最近一次 attempt 落盘时间（epoch ms）；同窗口重入幂等的判别依据。 */
  lastAttemptAt: number;
}

/** 手写校验（沿用本模块 _loadLlmRetryState 风格，不引 zod）。 */
export function parseExecutionRecoveryRecord(raw: unknown): ExecutionRecoveryRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== 1) return null;
  if (typeof r.contractId !== 'string' || r.contractId.length === 0) return null;
  if (typeof r.observedActivityAt !== 'number' || !Number.isFinite(r.observedActivityAt)) return null;
  if (typeof r.attempts !== 'number' || !Number.isInteger(r.attempts) || r.attempts < 0) return null;
  if (typeof r.lastAttemptAt !== 'number' || !Number.isFinite(r.lastAttemptAt)) return null;
  return {
    schema_version: 1,
    contractId: r.contractId,
    observedActivityAt: r.observedActivityAt,
    attempts: r.attempts,
    lastAttemptAt: r.lastAttemptAt,
  };
}

// ---------------------------------------------------------------------------
// Store — per-contract record 持久化（rootFs = chestnut root）
// ---------------------------------------------------------------------------

export interface ExecutionRecoveryStore {
  load(contractId: string): ExecutionRecoveryRecord | null;
  save(record: ExecutionRecoveryRecord): void;
  delete(contractId: string): void;
  list(): ExecutionRecoveryRecord[];
  /** chestnut-root 相对的 evidence 引用（交给 ContractFailure.evidenceRef）。 */
  recordRef(contractId: string): string;
}

function recordFileName(contractId: string): string {
  return `${contractId}.json`;
}

export function createExecutionRecoveryStore(deps: {
  rootFs: FileSystem;
  audit: AuditLog;
}): ExecutionRecoveryStore {
  const { rootFs, audit } = deps;
  const recordPath = (contractId: string): string =>
    path.join(EXECUTION_RECOVERY_DIR, recordFileName(contractId));

  return {
    load(contractId) {
      let raw: string;
      try {
        raw = rootFs.readSync(recordPath(contractId));
      } catch (e) {
        if (!isFileNotFound(e)) {
          audit.write(
            EVENTLOOP_AUDIT_EVENTS.FATAL,
            `context=executionRecoveryRecord`,
            `reason=read_failed`,
            `error=${formatErr(e)}`,
          );
        }
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=executionRecoveryRecord`,
          `reason=parse_failed`,
          `error=${formatErr(e)}`,
        );
        return null;
      }
      const record = parseExecutionRecoveryRecord(parsed);
      if (!record) {
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=executionRecoveryRecord`,
          `reason=schema_invalid`,
        );
        return null;
      }
      return record;
    },

    save(record) {
      rootFs.ensureDirSync(EXECUTION_RECOVERY_DIR);
      rootFs.writeAtomicSync(recordPath(record.contractId), JSON.stringify(record));
    },

    delete(contractId) {
      try {
        rootFs.deleteSync(recordPath(contractId));
      } catch (e) {
        if (!isFileNotFound(e)) {
          audit.write(
            EVENTLOOP_AUDIT_EVENTS.FATAL,
            `context=executionRecoveryRecord`,
            `reason=delete_failed`,
            `error=${formatErr(e)}`,
          );
        }
      }
    },

    list() {
      if (!rootFs.existsSync(EXECUTION_RECOVERY_DIR)) return [];
      let entries: { name: string; isDirectory: boolean }[];
      try {
        entries = rootFs.listSync(EXECUTION_RECOVERY_DIR);
      } catch (e) {
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=executionRecoveryRecord`,
          `reason=list_failed`,
          `error=${formatErr(e)}`,
        );
        return [];
      }
      const records: ExecutionRecoveryRecord[] = [];
      for (const e of entries) {
        if (e.isDirectory || !e.name.endsWith('.json')) continue;
        const record = this.load(e.name.slice(0, -'.json'.length));
        if (record) records.push(record);
      }
      return records;
    },

    recordRef(contractId) {
      // evidenceRef 用 posix 风格相对路径，跨平台稳定。
      return `${EXECUTION_RECOVERY_DIR}/${recordFileName(contractId)}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Activity 持久事实读取（Assembly probe 组装用；Step F 后取代 watchdog 侧同语义逻辑）
// ---------------------------------------------------------------------------

/**
 * 读 stream.jsonl 中最近一次执行 activity（LLM output / turn_interrupted）的 ts。
 * 与既有 inactivity 语义一致：直接 LLM 输出算 activity；turn_interrupted 也算
 * （claw 在跑被打断仍是活跃态）。无 stream 或无匹配事件返回 null。
 */
export async function readStreamExecutionActivityMs(
  clawFs: FileSystem,
  audit: AuditLog,
): Promise<number | null> {
  try {
    const events = await readAll(clawFs, STREAM_FILE, audit);
    let lastEventMs: number | null = null;
    for (const event of events) {
      const ts = typeof event.ts === 'number' ? event.ts : null;
      if (!ts) continue;
      if (
        (LLM_OUTPUT_EVENTS.has(event.type) || event.type === 'turn_interrupted') &&
        (lastEventMs === null || ts > lastEventMs)
      ) {
        lastEventMs = ts;
      }
    }
    return lastEventMs;
  } catch (err) {
    if (!isFileNotFound(err)) {
      audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=readStreamExecutionActivity`,
        `reason=${formatErr(err)}`,
      );
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Controller — observe(snapshot) 每 tick 由 EventLoop 调用
// ---------------------------------------------------------------------------

/**
 * 执行 activity 快照。所有字段必须由 caller 从持久事实 / 真实在途状态填充。
 * activeContractId 存在时 lastActivityAt 必须有效（contract 创建时间兜底）。
 */
export interface ExecutionActivitySnapshot {
  executorId: string;
  activeContractId?: string;
  lastActivityAt: number;
  turnInFlight: boolean;
  retryInFlight: boolean;
  asyncTaskInFlight: boolean;
}

/**
 * Consumer-owned failure sink（结构兼容 contract.ExecutionFailureSink；
 * 接口随消费者，event-loop 不 import contract 类型）。
 *
 * Phase 1398 Step C: 报告方只依据 resolve/reject 管理交付证据；Contract
 * lifecycle outcome（committed / retryable_failure 等）不可出现在本控制流。
 */
export interface ExecutionRecoveryFailureSink {
  report(input: {
    executorId: string;
    producer: string;
    reason: string;
    evidenceRef: string;
  }): Promise<void>;
}

export interface ExecutionRecoveryControllerDeps {
  store: ExecutionRecoveryStore;
  failureSink: ExecutionRecoveryFailureSink;
  audit: AuditLog;
  /** 向自身 inbox 写高优 resume event（由 EventLoop 绑定自身 inbox）。 */
  enqueueResume: (record: ExecutionRecoveryRecord) => void | Promise<void>;
  timeoutMs: number;
  maxAttempts?: number;
  now?: () => number;
}

export interface ExecutionRecoveryController {
  observe(snapshot: ExecutionActivitySnapshot): Promise<void>;
}

export function createExecutionRecoveryController(
  deps: ExecutionRecoveryControllerDeps,
): ExecutionRecoveryController {
  const { store, failureSink, audit } = deps;
  const maxAttempts = deps.maxAttempts ?? MAX_EXECUTION_RECOVERY_ATTEMPTS;
  const now = deps.now ?? (() => Date.now());

  async function deleteRecordsExcept(keepContractId?: string): Promise<void> {
    for (const record of store.list()) {
      if (record.contractId === keepContractId) continue;
      store.delete(record.contractId);
      audit.write(
        EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET,
        `contract=${record.contractId}`,
        `reason=contract_not_active`,
      );
    }
  }

  return {
    async observe(snapshot) {
      // 任一在途 → 执行未停滞，不打扰。
      if (snapshot.turnInFlight || snapshot.retryInFlight || snapshot.asyncTaskInFlight) return;

      const contractId = snapshot.activeContractId;
      if (!contractId) {
        // contract 不再 active（已 terminal / 被切换走）→ 清理全部残留 record。
        await deleteRecordsExcept(undefined);
        return;
      }
      // contract 切换 → 清理非当前 contract 的残留 record。
      await deleteRecordsExcept(contractId);

      let record = store.load(contractId);

      // activity 前进 → 本 epoch 已恢复 → 删除旧 record。
      if (record && snapshot.lastActivityAt > record.observedActivityAt) {
        store.delete(contractId);
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET,
          `contract=${contractId}`,
          `reason=activity_progressed`,
        );
        record = null;
      }

      const currentMs = now();
      // 未超时 → 不动作（lastActivityAt 是当前持久事实，record 未删时必等于
      // record.observedActivityAt，语义一致）。
      if (snapshot.lastActivityAt + deps.timeoutMs > currentMs) return;

      record ??= {
        schema_version: 1,
        contractId,
        observedActivityAt: snapshot.lastActivityAt,
        attempts: 0,
        lastAttemptAt: 0,
      };

      // 相同超时窗口重入幂等：每次新超时最多 +1 attempt。
      if (record.attempts > 0 && currentMs - record.lastAttemptAt < deps.timeoutMs) return;

      if (record.attempts < maxAttempts) {
        // 先落盘（重启可恢复计数），再向自身 inbox enqueue resume。
        const next: ExecutionRecoveryRecord = {
          ...record,
          attempts: record.attempts + 1,
          lastAttemptAt: currentMs,
        };
        store.save(next);
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME,
          `contract=${contractId}`,
          `attempt=${next.attempts}`,
          `max=${maxAttempts}`,
        );
        await deps.enqueueResume(next);
        return;
      }

      // attempts 耗尽：terminal evidence（attempts=max 的 record）已在上次 attempt
      // 落盘 → 交付 sink。report resolve 即闭合（terminal winner 已确定）→ 删
      // record；reject/抛错走 catch 保留 record 下 tick 重试交付，不重复恢复。
      try {
        await failureSink.report({
          executorId: snapshot.executorId,
          producer: 'runtime',
          reason: 'agent_spontaneous_stall',
          evidenceRef: store.recordRef(contractId),
        });
        store.delete(contractId);
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_FAILURE_DELIVERED,
          `contract=${contractId}`,
          `attempts=${record.attempts}`,
        );
      } catch (err) {
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_FAILED,
          `contract=${contractId}`,
          `reason=${formatErr(err)}`,
        );
      }
    },
  };
}
