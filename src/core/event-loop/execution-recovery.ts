/**
 * @module L5.EventLoop.ExecutionRecovery
 * @layer L5 服务层
 * @depends L1.NodeUtils, L2.AuditLog, L2.Fs, L2.Stream, Templates.Messages（层中性纯文案）
 * @consumers L5.EventLoop, L6.Assembly
 *
 * Phase 1396 Step E: EventLoop 自有的执行停滞恢复闭合。
 * Phase 1840: 执行提醒不再升级为契约失败——无活动/提醒次数是提醒事实，
 * 不是契约最终失败证据；提醒沿既有节奏持续，失败终态仍由 ContractSystem
 * 对真实失败来源独占裁决。
 * Phase 1841: 提醒记录按实例归属——记录写到本 claw 的
 * `<agentDir>/event-loop/execution-recovery/<contractId>.json`（motion 为
 * `<root>/motion/...`，worker 为 `<root>/claws/<id>/...`）；旧
 * `<root>/event-loop/execution-recovery/` 共享目录仅作只读历史基线继承
 * （归属不可考，原文与 unknown 标记随记录保留）。controller 只按当前选中
 * 契约 ID 直读直写，未选中/无 active 不授权删除任何记录，不扫描目录。
 * Phase 1842: 一次已决定的提醒先持久化 pending 交付义务（冻结稳定
 * id/attempt/scheduledAt/body），直到 Messaging 查询证实消息存在于
 * pending/inflight/done 才落 confirmed；投递失败或重启继续同一义务——
 * 不额外计次、不等待下一提醒窗口。新 activity 使旧 pending 转 superseded
 * （停止补投、保留身份与正文证据）。确认时刻起计算下一逻辑提醒窗口；
 * attempt 表示逻辑调度次数，不是物理写次数或成功通知次数。
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
   * Phase 1841: 可能包含归属未知的旧共享基线（见 legacySharedBaseline），
   * 不得当作「本 claw 已成功收到提醒消息数」。
   */
  attempts: number;
  /** 最近一次 attempt 落盘时间（epoch ms）；同窗口重入幂等的判别依据。 */
  lastAttemptAt: number;
  /**
   * Phase 1841: 旧 root 共享记录的只读继承证据（schema1 附加来源字段，
   * 五个原控制字段含义/格式不变）。旧 schema1 没有 clawId，无法恢复真实
   * 发送者；同 ID 还可能已被多实例互相覆盖，故归属恒为 unknown。raw 保存
   * 旧文件完整 UTF-8 原文（含空白与未知字段），不以重序列化替代。
   */
  legacySharedBaseline?: {
    attribution: 'unknown';
    raw: string;
  };
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
  let legacySharedBaseline: ExecutionRecoveryRecord['legacySharedBaseline'];
  if (r.legacySharedBaseline !== undefined) {
    const p = r.legacySharedBaseline;
    if (typeof p !== 'object' || p === null) return null;
    const prov = p as Record<string, unknown>;
    if (prov.attribution !== 'unknown') return null;
    if (typeof prov.raw !== 'string') return null;
    legacySharedBaseline = { attribution: 'unknown', raw: prov.raw };
  }
  const delivery = parseDelivery(r.delivery, r.attempts, r.lastAttemptAt);
  if (delivery === null) return null;
  return {
    schema_version: 1,
    contractId: r.contractId,
    observedActivityAt: r.observedActivityAt,
    attempts: r.attempts,
    lastAttemptAt: r.lastAttemptAt,
    ...(legacySharedBaseline ? { legacySharedBaseline } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

// ---------------------------------------------------------------------------
// Store — per-contract record 持久化（Phase 1841: 实例归属）
//
// 本地记录写到 agentFs（<agentDir>/event-loop/execution-recovery/），存在即权威；
// legacyRootFs（旧 root 共享目录）仅以 Pick<..., 'readSync'> 只读参与，且仅在
// 本地真缺失时作为共享历史基线继承一次。store 不提供 list/delete：本 claw 无权
// 枚举或清理任何记录（包括自己未选中的）。
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
  /** 旧 root 共享目录的只读来源；接口以 Pick 限制，调用方不得扩回 FileSystem。 */
  legacyRootFs: Pick<FileSystem, 'readSync'>;
  audit: AuditLog;
}): ExecutionRecoveryStore {
  const { agentFs, legacyRootFs, audit } = deps;
  const recordPath = (contractId: string): string =>
    path.join(EXECUTION_RECOVERY_DIR, recordFileName(contractId));

  const auditFailure = (...cols: string[]): void => {
    audit.write(EVENTLOOP_AUDIT_EVENTS.FATAL, `context=executionRecoveryRecord`, ...cols);
  };

  /**
   * 私有写：save 与 legacy 继承共用。rename 前失败原样抛出（调用者不 enqueue）；
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
   * 严格解析：JSON 解析 / schema（含来源字段）/ ID 一致性错误一律审计后抛出，
   * 不返回 null、不写任何文件。读取未知不能降格为「不存在」。
   */
  const parseStrict = (
    raw: string,
    scope: 'local' | 'legacy',
    contractId: string,
  ): ExecutionRecoveryRecord => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      auditFailure(`scope=${scope}`, `operation=read`, `contract=${contractId}`, `reason=parse_failed`, `error=${formatErr(e)}`);
      throw new Error(
        `execution recovery record ${scope} parse failed (contract=${contractId})`,
        { cause: e },
      );
    }
    // Phase 1842: legacy scope 在严格解析前只为控制投影移除 delivery 字段——
    // 旧 root 共享记录没有实例身份，其 delivery（无论格式是否合法）不能证明本
    // claw 的交付义务，不继承、不阻断；完整原文仍随 legacySharedBaseline.raw
    // 保留为来源证据。这是显式兼容决策，不是静默忽略。local scope 不做投影：
    // 本地 delivery 无效即整个 record 无效。
    const projectionSource =
      scope === 'legacy' && typeof parsed === 'object' && parsed !== null
        ? (() => {
            const copy = { ...(parsed as Record<string, unknown>) };
            delete copy.delivery;
            return copy;
          })()
        : parsed;
    const record = parseExecutionRecoveryRecord(projectionSource);
    if (!record) {
      auditFailure(`scope=${scope}`, `operation=read`, `contract=${contractId}`, `reason=schema_invalid`);
      throw new Error(`execution recovery record ${scope} schema invalid (contract=${contractId})`);
    }
    if (record.contractId !== contractId) {
      auditFailure(`scope=${scope}`, `operation=read`, `contract=${contractId}`, `reason=id_mismatch`);
      throw new Error(`execution recovery record ${scope} id mismatch (contract=${contractId})`);
    }
    return record;
  };

  return {
    load(contractId) {
      const relPath = recordPath(contractId);
      // 1) 本地优先：直接读，不以 existsSync 预判。成功即权威返回（包括
      //    attempts=0 的已建立本地状态），不再读取 legacy。
      let localRaw: string | undefined;
      try {
        localRaw = agentFs.readSync(relPath);
      } catch (e) {
        if (!isFileNotFound(e)) {
          auditFailure(`scope=local`, `operation=read`, `contract=${contractId}`, `reason=read_failed`, `error=${formatErr(e)}`);
          throw e;
        }
      }
      if (localRaw !== undefined) {
        return parseStrict(localRaw, 'local', contractId);
      }
      // 2) 仅本地真缺失（ENOENT）才读旧共享基线；其他读取错误原样抛出。
      let legacyRaw: string;
      try {
        legacyRaw = legacyRootFs.readSync(relPath);
      } catch (e) {
        if (isFileNotFound(e)) {
          // 两侧真缺失 → 首次观察：不建立空状态，首次实际 save 才建本地文件。
          return null;
        }
        auditFailure(`scope=legacy`, `operation=read`, `contract=${contractId}`, `reason=read_failed`, `error=${formatErr(e)}`);
        throw e;
      }
      // 3) 旧共享基线继承：五个控制字段原样投影，附完整原文与 unknown 归属
      //    标记。不采用旧输入中的同名来源字段伪造新来源。root 字节始终不变。
      const legacyRecord = parseStrict(legacyRaw, 'legacy', contractId);
      const inherited: ExecutionRecoveryRecord = {
        ...legacyRecord,
        legacySharedBaseline: { attribution: 'unknown', raw: legacyRaw },
      };
      // 先落盘再返回：迁移写失败则抛，不返回可继续 enqueue 的记录。
      writeRecord(inherited);
      audit.write(
        EVENTLOOP_AUDIT_EVENTS.ITERATION,
        `context=executionRecoveryLegacyImport`,
        `contract=${contractId}`,
        `source=root_shared`,
        `attribution=unknown`,
      );
      return inherited;
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
    store.save({
      ...record,
      delivery: { ...delivery, kind: 'confirmed', confirmedAt },
    });
    audit.write(
      EVENTLOOP_AUDIT_EVENTS.ITERATION,
      `context=executionRecoveryDeliveryConfirmed`,
      `contract=${contractId}`,
      `delivery_id=${delivery.id}`,
      `confirmed_at=${confirmedAt}`,
    );
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
      // 事实与 legacy 来源证据，重启不会重新导入旧共享基线），再判断活动是否超时，
      // 不留「内存已重置、磁盘旧值」窗口。spread 保留 legacySharedBaseline。
      // Phase 1842: 旧 pending 义务同次转 superseded（停止后续补投，保留冻结身份
      // 与正文证据；不召回已写消息，也不宣称旧消息从未投递）；旧 confirmed /
      // superseded 保持原证据。save 失败终止本次，不能继续交付。superseded 与
      // 后续新 pending 之间可崩溃；重启按保存状态继续。
      if (record && snapshot.lastActivityAt > record.observedActivityAt) {
        const previous = record;
        record = {
          ...record,
          observedActivityAt: snapshot.lastActivityAt,
          attempts: 0,
          lastAttemptAt: 0,
          ...(record.delivery?.kind === 'pending'
            ? {
                delivery: {
                  ...record.delivery,
                  kind: 'superseded' as const,
                  supersededAt: now(),
                  reason: 'activity_progressed' as const,
                },
              }
            : {}),
        };
        store.save(record);
        audit.write(
          EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESET,
          `contract=${contractId}`,
          `reason=activity_progressed`,
          `previous_record=${JSON.stringify(previous)}`,
        );
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

      // Phase 1840: 提醒没有次数上限——到期窗口无条件登记下一次 attempt；
      // attempts 不再携带终态含义。Phase 1842: 新义务冻结稳定 id/attempt/
      // scheduledAt/body（模板一次渲染），先 save 完整新 record（重启可按原样
      // 恢复义务），再 RESUME 审计，再交付。audit 的 RESUME 表示一次已登记的
      // 调度尝试与 pending 义务落盘，不表示 owner 已确认消息存在。save 抛错
      // 不调用适配器；审计与 save 不构成完整事务日志，历史 gap 保持。
      const delivery: Extract<ExecutionRecoveryDelivery, { kind: 'pending' }> = {
        kind: 'pending',
        id: `${DELIVERY_ID_PREFIX}${newUuid()}`,
        attempt: record.attempts + 1,
        scheduledAt: currentMs,
        body: executionRecoveryMessage(contractId, record.attempts + 1),
      };
      const next: ExecutionRecoveryRecord = {
        ...record,
        attempts: delivery.attempt,
        lastAttemptAt: currentMs,
        delivery,
      };
      store.save(next);
      audit.write(
        EVENTLOOP_AUDIT_EVENTS.EXECUTION_RECOVERY_RESUME,
        `contract=${contractId}`,
        `attempt=${next.attempts}`,
        `interval_ms=${deps.timeoutMs}`,
        `delivery_id=${delivery.id}`,
        `delivery_state=pending`,
        // 覆盖上一 delivery 前留证（没有则不加本列）。
        ...(record.delivery ? [`previous_delivery=${JSON.stringify(record.delivery)}`] : []),
      );
      await deliverObligation(contractId, next, delivery);
    },
  };
}
