/**
 * @module L5.EventLoop.ExecutionRecovery
 * @layer L5 服务层
 * @depends L1.NodeUtils, L2.AuditLog, L2.Fs, L2.Stream, L2b.LLMOrchestrator（type-only 恢复安排类型）, Templates.Messages（层中性纯文案）
 * @consumers L5.EventLoop, L6.Assembly
 *
 * Phase 1396 Step E: EventLoop 自有的执行停滞恢复闭合。
 * Phase 1840: 执行提醒不再升级为契约失败——无活动/提醒次数是提醒事实，
 * 不是契约最终失败证据；提醒沿既有节奏持续，失败终态仍由 ContractSystem
 * 对真实失败来源独占裁决。
 * Phase 1841: 提醒记录按实例归属——记录写到本 claw 的
 * `<agentDir>/event-loop/execution-recovery/<contractId>.json`（motion 为
 * `<root>/motion/...`，worker 为 `<root>/claws/<id>/...`）。
 * phase 1890 Step D：旧 root 共享目录基线继承面删除（存量废弃）——本地
 * 缺失即首次观察。controller 只按当前选中
 * 契约 ID 直读直写，未选中/无 active 不授权删除任何记录，不扫描目录。
 * Phase 1842: 一次已决定的提醒先持久化 pending 交付义务（冻结稳定
 * id/attempt/scheduledAt/body），直到 Messaging 查询证实消息存在于
 * pending/inflight/done 才落 confirmed；投递失败或重启继续同一义务——
 * 不额外计次、不等待下一提醒窗口。新 activity 使旧 pending 转 superseded
 * （停止补投、保留身份与正文证据）。确认时刻起计算下一逻辑提醒窗口；
 * attempt 表示逻辑调度次数，不是物理写次数或成功通知次数。
 *
 * Phase 1843: 到期准备登记新提醒时，如果本 claw pending 中已有本 claw 发出的
 * 同契约 execution_recovery 消息，则不登记新义务、不增加调度次数；读取未知
 * 同样停止本次新增并显式审计。已持久 pending 义务仍按 1842 稳定身份恢复，
 * 不经此检查。
 * Phase 1869 (Step F): 变迁证据链 write-ahead —— 每类状态变迁（epoch reset /
 * 新登记 / 交付确认）的审计事件先于状态覆盖写落盘，载荷自含将写入的完整
 * record（next_record；reset 另含 previous_record 全量）；崩溃窗口方向 =
 * 「审计有、状态未前移」，重启以状态文件为权威、下一 tick 重推同变迁收敛到
 * 唯一当前态（收敛由 record 权威性保证，不做审计尾部扫描探测）。supersede
 * 为交付级独立变迁，由独立事件承载。完整性边界：状态变迁级可重建（不含消息级
 * 重建）；文件系统级事务 / 重放级 journal 不在本协议，如需 → 升档独立 phase。
 * Phase 1844: 新登记前只读 inspect LLM owner 公开恢复安排——尚未到时的 at
 * 说明 owner 已安排未来重试，本次不登记新提醒、不增加 attempt、不修改 owner
 * 安排（不另持有等待状态或 timer）；inspect 读取失败/非法 resumeAt 同样停止
 * 本次新增并审计留证（未知不是 ready）。ready/on_change/未注入 owner 及已到
 * 期（含恰好到期）的 at 继续原 1843 查询路径；继续登记不等于准入，实际请求
 * 仍由 owner.begin 唯一决定。已持久 pending 义务不经此检查（即使 inspect
 * 会抛错也不调用）。
 *
 * 职责边界：
 * - EventLoop 判断活进程中的 agent 执行是否自发停滞（无 turn/retry/task 在途、
 *   active contract 存在、持久 activity 超时），先本模块自恢复（向自身 inbox 写
 *   高优 resume event，正常 drain 消费，不调 Runtime reentrant API）；
 * - 提醒没有次数上限：每个到期窗口至多一次 attempt，超过旧阈值仍按同一节奏
 *   继续；本模块不发起契约失败，不直接改 contract、不通知 motion；
 * - recovery state 全落盘到本实例目录（见上），daemon 重启后从 record 恢复
 *   attempt 计数与交付义务。
 *
 * 持久事实约束（计划 §10 风险）：`lastActivityAt` 必须来自 Stream/Contract 已持久
 * 事实，不得用内存 timer；恢复消息自身不产生 stream LLM output，天然不算业务
 * progress，不会永远重置计数。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr, newUuid } from '../../foundation/node-utils/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { readAll, STREAM_FILE, LLM_OUTPUT_EVENTS } from '../../foundation/stream/index.js';
import type { LLMRecoverySchedule } from '../../foundation/llm-orchestrator/index.js';
import { executionRecoveryMessage } from '../../templates/messages/index.js';
import { EXECUTION_RECOVERY_DIR } from './constants.js';
import { EVENTLOOP_AUDIT_EVENTS } from './audit-events.js';

// ---------------------------------------------------------------------------
// Record schema
// ---------------------------------------------------------------------------

export interface ExecutionRecoveryRecord {
  schema_version: 1;
  contractId: string;
  /** 本 recovery epoch 观察到的最后一次持久 activity（epoch ms）。 */
  observedActivityAt: number;
  /**
   * 调度计数（1-based 累计）：本模块登记过的 resume 调度尝试次数。
   */
  attempts: number;
  /** 最近一次 attempt 落盘时间（epoch ms）；同窗口重入幂等的判别依据。 */
  lastAttemptAt: number;
  /**
   * Phase 1842: 交付义务（可选，schema_version 仍为 1，旧记录无此字段合法）。
   * pending = 已决定但未经 Messaging 证实的义务（冻结 id/attempt/scheduledAt/body，
   * 跨重启按原样补投）；confirmed = owner 查询证实消息存在；superseded = 新
   * activity 前进终止补投（保留身份/正文证据，不召回已写消息）。
   */
  delivery?: ExecutionRecoveryDelivery;
}

// ---------------------------------------------------------------------------
// Delivery obligation（Phase 1842）
// ---------------------------------------------------------------------------

/** delivery.id 的稳定前缀（`execution_recovery-${newUuid()}`）。 */
const DELIVERY_ID_PREFIX = 'execution_recovery-';

/** Date 可表示的毫秒范围（±8.64e15）。 */
const MAX_DATE_MS = 8.64e15;

interface ExecutionRecoveryDeliveryBase {
  /** 稳定身份：登记时冻结，重启/补投/确认全程不变。 */
  id: string;
  /** 逻辑调度次数（与 record.attempts 一致），不是物理写次数。 */
  attempt: number;
  /** 登记时刻（epoch ms，冻结；与 record.lastAttemptAt 一致）。 */
  scheduledAt: number;
  /** 一次渲染后冻结的正文；重启/补投不重新渲染。 */
  body: string;
}

export type ExecutionRecoveryDelivery =
  | (ExecutionRecoveryDeliveryBase & { kind: 'pending' })
  | (ExecutionRecoveryDeliveryBase & { kind: 'confirmed'; confirmedAt: number })
  | (ExecutionRecoveryDeliveryBase & {
      kind: 'superseded';
      supersededAt: number;
      reason: 'activity_progressed';
    });

/** 交给交付适配器的义务（只可能是 pending）。 */
export interface ExecutionRecoveryDeliveryRequest {
  contractId: string;
  delivery: Extract<ExecutionRecoveryDelivery, { kind: 'pending' }>;
}

/**
 * 交付结果。confirmed = owner 查询证实消息存在（pending/inflight/done 任一）；
 * pending = 未能证实（携带失败阶段与原 error），义务原样保留待下一 observe。
 * 回调 resolve 本身不构成确认。
 */
export type ExecutionRecoveryDeliveryOutcome =
  | { kind: 'confirmed' }
  | { kind: 'pending'; stage: 'query_before' | 'write' | 'query_after'; error: unknown };

// ---------------------------------------------------------------------------
// Pending 新增抑制（Phase 1843）
// ---------------------------------------------------------------------------

/**
 * 新登记前的 owner 未结算事实查询结果（EventLoop 模块内部契约，经 EventLoop 的
 * protected 适配从 Messaging.peekUnsettled 取得）。absent = 同三要素提醒不存在；
 * present = 精确命中（type=execution_recovery、from=本 claw、
 * metadata.contract_id=本契约），携带首个 messageId 与命中总数（pending +
 * inflight 双位置，phase 1869 Step C 起不再 pending-only）。读取未知
 * 由回调以 rejection 保留实际异常，不得折成 absent。
 */
export type PendingExecutionResume =
  | { kind: 'absent' }
  | { kind: 'present'; messageId: string; count: number };

function isRepresentableMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_DATE_MS;
}

/**
 * delivery 字段严格校验。缺省合法（旧记录）；显式 null / 未知 kind / 字段不合法
 * 或与顶部计数不一致 → 整个 record 无效（返回 null，由 store 审计后抛出）。
 * 不引入「确认时间必须大于登记时间」的时钟单调假设。
 */
function parseDelivery(
  raw: unknown,
  attempts: number,
  lastAttemptAt: number,
): ExecutionRecoveryDelivery | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (
    typeof d.id !== 'string' ||
    !d.id.startsWith(DELIVERY_ID_PREFIX) ||
    d.id.length === DELIVERY_ID_PREFIX.length
  ) return null;
  if (typeof d.attempt !== 'number' || !Number.isInteger(d.attempt) || d.attempt < 1) return null;
  if (typeof d.body !== 'string' || d.body.length === 0) return null;
  if (!isRepresentableMs(d.scheduledAt)) return null;
  const base = { id: d.id, attempt: d.attempt, scheduledAt: d.scheduledAt, body: d.body };
  switch (d.kind) {
    case 'pending':
      // pending 必须与本 epoch 顶部计数一致（最后一次登记的义务）。
      if (d.attempt !== attempts || d.scheduledAt !== lastAttemptAt) return null;
      return { ...base, kind: 'pending' };
    case 'confirmed': {
      if (!isRepresentableMs(d.confirmedAt)) return null;
      if (attempts > 0) {
        if (d.attempt !== attempts || d.scheduledAt !== lastAttemptAt) return null;
      } else if (lastAttemptAt !== 0) {
        // attempts=0 只允许 activity 重置后的零基线（lastAttemptAt=0）保留旧证据。
        return null;
      }
      return { ...base, kind: 'confirmed', confirmedAt: d.confirmedAt };
    }
    case 'superseded':
      if (!isRepresentableMs(d.supersededAt)) return null;
      if (d.reason !== 'activity_progressed') return null;
      // superseded 只能出现在 activity 重置后的零基线上。
      if (attempts !== 0 || lastAttemptAt !== 0) return null;
      return { ...base, kind: 'superseded', supersededAt: d.supersededAt, reason: 'activity_progressed' };
    default:
      return null;
  }
}

/** 手写校验（沿用本模块 _loadLlmRetryState 风格，不引 zod）。纯解析返回 null；
 *  存在但格式无效的来源字段同样返回 null（由 store 决定审计/抛出，不静默丢弃）。 */
export function parseExecutionRecoveryRecord(raw: unknown): ExecutionRecoveryRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema_version !== 1) return null;
  if (typeof r.contractId !== 'string' || r.contractId.length === 0) return null;
  if (typeof r.observedActivityAt !== 'number' || !Number.isFinite(r.observedActivityAt)) return null;
  if (typeof r.attempts !== 'number' || !Number.isInteger(r.attempts) || r.attempts < 0) return null;
  if (typeof r.lastAttemptAt !== 'number' || !Number.isFinite(r.lastAttemptAt)) return null;
  const delivery = parseDelivery(r.delivery, r.attempts, r.lastAttemptAt);
  if (delivery === null) return null;
  return {
    schema_version: 1,
    contractId: r.contractId,
    observedActivityAt: r.observedActivityAt,
    attempts: r.attempts,
    lastAttemptAt: r.lastAttemptAt,
    ...(delivery ? { delivery } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store — per-contract record 持久化（Phase 1841: 实例归属）
//
// 本地记录写到 agentFs（<agentDir>/event-loop/execution-recovery/），存在即权威；
// 本地真缺失即首次观察（不建立空状态，首次实际 save 才建本地文件）。store 不
// 提供 list/delete：本 claw 无权枚举或清理任何记录（包括自己未选中的）。
// ---------------------------------------------------------------------------

export interface ExecutionRecoveryStore {
  load(contractId: string): ExecutionRecoveryRecord | null;
  save(record: ExecutionRecoveryRecord): void;
}

/**
 * 记录文件名。拒绝空 / 点段 / 路径分隔 / NUL——record 路径不得越出本实例
 * recovery 目录、成为实例内其他资源地址。load/save 共用此校验。
 */
function recordFileName(contractId: string): string {
  if (
    contractId.length === 0 ||
    contractId === '.' ||
    contractId === '..' ||
    contractId.includes('/') ||
    contractId.includes('\\') ||
    contractId.includes('\0')
  ) {
    throw new Error(`execution recovery record: invalid contractId ${JSON.stringify(contractId)}`);
  }
  return `${contractId}.json`;
}

export function createExecutionRecoveryStore(deps: {
  agentFs: FileSystem;
  audit: AuditLog;
}): ExecutionRecoveryStore {
  const { agentFs, audit } = deps;
  const recordPath = (contractId: string): string =>
    path.join(EXECUTION_RECOVERY_DIR, recordFileName(contractId));

  const auditFailure = (...cols: string[]): void => {
    audit.write(EVENTLOOP_AUDIT_EVENTS.FATAL, `context=executionRecoveryRecord`, ...cols);
  };

  /**
   * 私有写：save 专用。rename 前失败原样抛出（调用者不 enqueue）；
   * rename 已提交的两种受限耐久性结果只审计留证——不能删除、回滚、当未写成
   * 重写或再加 attempt。
   */
  const writeRecord = (record: ExecutionRecoveryRecord): void => {
    // 先校验 contractId 生成路径，再建目录：坏 ID 不得在实例目录留任何痕迹。
    const target = recordPath(record.contractId);
    agentFs.ensureDirSync(EXECUTION_RECOVERY_DIR);
    const result = agentFs.writeAtomicSync(target, JSON.stringify(record));
    switch (result.kind) {
      case 'durable':
        break;
      case 'committed_platform_limited':
      case 'committed_durability_unknown':
        auditFailure(
          `operation=write`,
          `contract=${record.contractId}`,
          `durability=${result.kind}`,
          `error=${formatErr(result.error)}`,
        );
        break;
      default: {
        const impossible: never = result;
        throw new Error(`Unexpected execution recovery write result: ${String(impossible)}`);
      }
    }
  };

  /**
   * 严格解析：JSON 解析 / schema / ID 一致性错误一律审计后抛出，
   * 不返回 null、不写任何文件。读取未知不能降格为「不存在」。
   */
  const parseStrict = (
    raw: string,
    contractId: string,
  ): ExecutionRecoveryRecord => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      auditFailure(`operation=read`, `contract=${contractId}`, `reason=parse_failed`, `error=${formatErr(e)}`);
      throw new Error(
        `execution recovery record parse failed (contract=${contractId})`,
        { cause: e },
      );
    }
    const record = parseExecutionRecoveryRecord(parsed);
    if (!record) {
      auditFailure(`operation=read`, `contract=${contractId}`, `reason=schema_invalid`);
      throw new Error(`execution recovery record schema invalid (contract=${contractId})`);
    }
    if (record.contractId !== contractId) {
      auditFailure(`operation=read`, `contract=${contractId}`, `reason=id_mismatch`);
      throw new Error(`execution recovery record id mismatch (contract=${contractId})`);
    }
    return record;
  };

  return {
    load(contractId) {
      const relPath = recordPath(contractId);
      // 本地记录存在即权威（包括 attempts=0 的已建立本地状态）。
      let localRaw: string | undefined;
      try {
        localRaw = agentFs.readSync(relPath);
      } catch (e) {
        if (!isFileNotFound(e)) {
          auditFailure(`operation=read`, `contract=${contractId}`, `reason=read_failed`, `error=${formatErr(e)}`);
          throw e;
        }
      }
      if (localRaw !== undefined) {
        return parseStrict(localRaw, contractId);
      }
      // 本地真缺失 → 首次观察：不建立空状态，首次实际 save 才建本地文件。
      return null;
    },

    save(record) {
      writeRecord(record);
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
  activeContractId?: string;
  lastActivityAt: number;
  turnInFlight: boolean;
  retryInFlight: boolean;
  asyncTaskInFlight: boolean;
}

interface ExecutionRecoveryControllerDeps {
  store: ExecutionRecoveryStore;
  audit: AuditLog;
  /**
   * Phase 1842: 交付义务适配器（由 EventLoop 绑定真实 owner 读写链）。
   * 以冻结的稳定 delivery.id 先查询 owner 消息存在证据，未命中才写，
   * 再以写后查询确认；回调 resolve 不等于确认。依赖在构造时绑定，不动态替换。
   */
  deliverResume: (request: ExecutionRecoveryDeliveryRequest) => Promise<ExecutionRecoveryDeliveryOutcome>;
  /**
   * Phase 1843: 新登记前查询本 claw pending 是否已有同契约执行提醒（精确三要素
   * 匹配由适配侧完成）。必需依赖——不得默认 absent，避免漏接生产能力静默放行；
   * 查询未知以 rejection 保留实际异常，controller 审计后停止本次新增。
   */
  findPendingResume: (contractId: string) => Promise<PendingExecutionResume>;
  /**
   * Phase 1844: 新登记前只读查询 LLM owner 公开恢复安排（复用 owner 三态类型，
   * 不自建「是否可调用 LLM」协议）。必需依赖——不得默认 ready/undefined 函数，
   * 编译器检查所有 controller 构造。返回 undefined 只表示装配未注入 recovery
   * owner；读取失败以 rejection 保留实际异常，不得折 undefined/ready。
   * revision/resumeAt 仅用于判断与审计，不解析 owner 持久 schema。
   */
  inspectLlmRecoverySchedule: () => Promise<LLMRecoverySchedule | undefined>;
  timeoutMs: number;
  now?: () => number;
}

export interface ExecutionRecoveryController {
  observe(snapshot: ExecutionActivitySnapshot): Promise<void>;
}

export function createExecutionRecoveryController(
  deps: ExecutionRecoveryControllerDeps,
): ExecutionRecoveryController {
  const { store, audit } = deps;
  const now = deps.now ?? (() => Date.now());

  /**
   * 交付一次 pending 义务（新登记或补投共用）。失败只审计保留义务，不抛给
   * 智能体、不自循环；confirmed 时把同一 record 的 delivery 落为 confirmed
   * （save 失败原样抛出——磁盘仍是 pending，下一 observe 先查询原消息再确认，
   * 不会重复写、不额外计次）。无论确认花了多久，当次 observe 均 return，
   * 不立即登记下一提醒。
   */
  const deliverObligation = async (
    contractId: string,
    record: ExecutionRecoveryRecord,
    delivery: Extract<ExecutionRecoveryDelivery, { kind: 'pending' }>,
  ): Promise<void> => {
    const outcome = await deps.deliverResume({ contractId, delivery });
    if (outcome.kind === 'pending') {
      audit.write(
        EVENTLOOP_AUDIT_EVENTS.FATAL,
        `context=executionRecoveryDelivery`,
        `contract=${contractId}`,
        `delivery_id=${delivery.id}`,
        `stage=${outcome.stage}`,
        `error=${formatErr(outcome.error)}`,
      );
      return;
    }
    const confirmedAt = now();
    const next: ExecutionRecoveryRecord = {
      ...record,
      delivery: { ...delivery, kind: 'confirmed', confirmedAt },
    };
    // Phase 1869 (Step F): write-ahead —— 确认证据先于状态覆盖写；载荷含将写入
    // 全量 record。崩溃窗口方向 = 「审计有（confirmed 意图）、状态未前移」，重启
    // 以状态为准（仍 pending）→ 预查询命中原消息 → 再确认，收敛到唯一当前态。
    audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `context=executionRecoveryDeliveryConfirmed`,
      `contract=${contractId}`,
      `delivery_id=${delivery.id}`,
      `confirmed_at=${confirmedAt}`,
      `next_record=${JSON.stringify(next)}`,
    );
    store.save(next);
  };

  return {
    async observe(snapshot) {
      // 任一在途 → 执行未停滞，不打扰。
      if (snapshot.turnInFlight || snapshot.retryInFlight || snapshot.asyncTaskInFlight) return;

      // Phase 1841: 只按当前选中契约 ID 直读直写本 claw 本地记录。「本次没有选中」
      // 不构成其他契约的终态事实（probe 底层扫描还可能折空），不授权删除任何记录——
      // 无 active、契约切换、已终态而不再被选中的记录均原样保留。
      const contractId = snapshot.activeContractId;
      if (!contractId) return;

      let record = store.load(contractId);

      // activity 前进 → 本 epoch 已恢复：先持久化零计数记录（保留「已建立本地状态」
      // 事实，重启后按本地记录继续），再判断活动是否超时，
      // 不留「内存已重置、磁盘旧值」窗口。
      // Phase 1842: 旧 pending 义务同次转 superseded（停止后续补投，保留冻结身份
      // 与正文证据；不召回已写消息，也不宣称旧消息从未投递）；旧 confirmed /
      // superseded 保持原证据。save 失败终止本次，不能继续交付。superseded 与
      // 后续新 pending 之间可崩溃；重启按保存状态继续。
      if (record && snapshot.lastActivityAt > record.observedActivityAt) {
        const previous = record;
        const pendingDelivery = previous.delivery?.kind === 'pending' ? previous.delivery : undefined;
        record = {
          ...record,
          observedActivityAt: snapshot.lastActivityAt,
          attempts: 0,
          lastAttemptAt: 0,
          ...(pendingDelivery
            ? {
                delivery: {
                  ...pendingDelivery,
                  kind: 'superseded' as const,
                  supersededAt: now(),
                  reason: 'activity_progressed' as const,
                },
              }
            : {}),
        };
        // Phase 1869 (Step F): write-ahead —— 事件先于状态覆盖写，载荷自含
        // previous/next 全量记录（崩溃窗口方向 = 「审计有、状态未前移」，重启以
        // 状态为准、下 tick 重推同变迁收敛）。
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET,
          `contract=${contractId}`,
          `reason=activity_progressed`,
          `previous_record=${JSON.stringify(previous)}`,
          `next_record=${JSON.stringify(record)}`,
        );
        // Phase 1869 (Step F): supersede 是交付级独立变迁——独立事件承载
        // （此前仅内嵌于 reset 载荷的 previous_record，交付链不可独立重建）。
        if (pendingDelivery) {
          audit.write(
            EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_DELIVERY_SUPERSEDED,
            `contract=${contractId}`,
            `delivery_id=${pendingDelivery.id}`,
            `reason=activity_progressed`,
          );
        }
        store.save(record);
      }

      // Phase 1842: 已有 pending 义务 → 直接交付该义务（同一冻结身份/正文），
      // 不检查 lastAttemptAt 冷却、不重新增加 attempt；每次 observe 只交付一次并 return。
      if (record?.delivery?.kind === 'pending') {
        await deliverObligation(contractId, record, record.delivery);
        return;
      }

      const currentMs = now();
      // 未超时 → 不动作（lastActivityAt 是当前持久事实，record 未重置时必等于
      // record.observedActivityAt，语义一致）。
      if (snapshot.lastActivityAt + deps.timeoutMs > currentMs) return;

      record ??= {
        schema_version: 1,
        contractId,
        observedActivityAt: snapshot.lastActivityAt,
        attempts: 0,
        lastAttemptAt: 0,
      };

      // 相同超时窗口重入幂等：每个新窗口最多登记一次新义务。
      // Phase 1842: 下一逻辑提醒窗口自确认时刻起算——attempts>0 且有 confirmed
      // 义务时以 confirmedAt 为基线；旧无 delivery 记录沿用 lastAttemptAt。
      // attempts=0 不受保留的旧 confirmed 时间限制。
      if (record.attempts > 0) {
        const baseline =
          record.delivery?.kind === 'confirmed' ? record.delivery.confirmedAt : record.lastAttemptAt;
        if (currentMs - baseline < deps.timeoutMs) return;
      }

      // Phase 1844: 新登记前只读 inspect LLM owner 公开安排——尚未到时的 at
      // 说明 owner 已安排未来重试，本次不登记新提醒、不增加 attempt、不修改
      // owner 安排。读取失败/非法 resumeAt（类型合法但日期无效，NaN 比较会为
      // false 而误放行）同样拒绝新增并显式留证；检查未知不是 ready。抑制只记
      // 审计，不另持有等待状态或 timer，不对未到期观察增加查询之外的写。
      // 时间比较在 inspect 完成后取当前时刻：边界 resumeAt === now 已到期，
      // 不因 inspect 仍返回 at 继续抑制。ready/on_change/undefined 及已到期 at
      // 继续原 1843 查询——继续登记不等于准入，实际请求仍由 owner.begin 唯一
      // 决定。本检查只拦截新登记：已持久 pending 义务在上游已先行交付并
      // return，不经此分支（即使 inspect 会抛错也不调用）。
      let schedule: LLMRecoverySchedule | undefined;
      let resumeMs: number | undefined;
      try {
        schedule = await deps.inspectLlmRecoverySchedule();
        if (schedule?.kind === 'at') {
          resumeMs = Date.parse(schedule.resumeAt);
          if (!Number.isFinite(resumeMs)) {
            throw new Error('execution recovery received invalid LLM resumeAt');
          }
        }
      } catch (error) {
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=executionRecoveryScheduleCheck`,
          `contract=${contractId}`,
          `error=${formatErr(error)}`,
        );
        return;
      }
      if (schedule?.kind === 'at' && resumeMs !== undefined && resumeMs > now()) {
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.ITERATION,
          `context=executionRecoveryScheduleCheck`,
          `contract=${contractId}`,
          `reason=llm_retry_scheduled`,
          `schedule_revision=${schedule.revision}`,
          `resume_at=${schedule.resumeAt}`,
        );
        return;
      }

      // Phase 1843: 新登记前查 owner pending——已有本 claw 同契约执行提醒则
      // 不生成 ID/正文、不增加 attempt、不写新义务（该消息本身仍是待消费的
      // 等价唤醒机会）。查询未知同样停止本次新增（审计留证），不能当 absent
      // 静默新增。命中不延长窗口、不写 suppressed 状态；消费后下一符合条件
      // observe 即可重新判断。本检查只拦截新登记：已持久 pending 义务在上游
      // 已先行交付并 return，不经此分支。
      let pendingResume: PendingExecutionResume;
      try {
        pendingResume = await deps.findPendingResume(contractId);
      } catch (error) {
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.FATAL,
          `context=executionRecoveryPendingCheck`,
          `contract=${contractId}`,
          `error=${formatErr(error)}`,
        );
        return;
      }
      if (pendingResume.kind === 'present') {
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.ITERATION,
          `context=executionRecoveryPendingCheck`,
          `contract=${contractId}`,
          `reason=pending_reminder_exists`,
          `message_id=${pendingResume.messageId}`,
          // Phase 1869 (Step C): 命中总数（pending + inflight）——积压规模可观察。
          `count=${pendingResume.count}`,
        );
        return;
      }

      // Phase 1840: 提醒没有次数上限——到期窗口无条件登记下一次 attempt；
      // attempts 不再携带终态含义。Phase 1842: 新义务冻结稳定 id/attempt/
      // scheduledAt/body（模板一次渲染）。Phase 1869 (Step F): write-ahead ——
      // RESUME 审计先于 save，载荷含将写入全量 record + previous_delivery 留证；
      // 崩溃窗口方向 = 「审计有（登记意图）、状态未前移」，重启以状态为准、
      // 下 tick 重登记收敛（孤儿行含未落盘 delivery_id，不产生物理写）。
      // audit 的 RESUME 表示一次登记意图与 pending 义务证据，不表示 owner 已确认
      // 消息存在。save 抛错不调用适配器（审计意图行保留、可发现）。
      const delivery: Extract<ExecutionRecoveryDelivery, { kind: 'pending' }> = {
        kind: 'pending',
        id: `${DELIVERY_ID_PREFIX}${newUuid()}`,
        attempt: record.attempts + 1,
        scheduledAt: currentMs,
        body: executionRecoveryMessage(contractId),
      };
      const next: ExecutionRecoveryRecord = {
        ...record,
        attempts: delivery.attempt,
        lastAttemptAt: currentMs,
        delivery,
      };
      audit.write(
        EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME,
        `contract=${contractId}`,
        `attempt=${next.attempts}`,
        `interval_ms=${deps.timeoutMs}`,
        `delivery_id=${delivery.id}`,
        `delivery_state=pending`,
        `next_record=${JSON.stringify(next)}`,
        // 覆盖上一 delivery 前留证（没有则不加本列）。
        ...(record.delivery ? [`previous_delivery=${JSON.stringify(record.delivery)}`] : []),
      );
      store.save(next);
      await deliverObligation(contractId, next, delivery);
    },
  };
}
