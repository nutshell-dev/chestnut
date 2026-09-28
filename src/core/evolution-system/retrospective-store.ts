/**
 * @module L4.EvolutionSystem.RetrospectiveStore
 *
 * Phase 1206 Step B: EvolutionSystem-owned retrospective work item store.
 *
 * Three-state disk layout:
 *   clawspace/evolution/retrospectives/ready/<contractId>.json
 *   clawspace/evolution/retrospectives/dispatching/<contractId>.json
 *   clawspace/evolution/retrospectives/submitted/<contractId>.json
 *
 * Rules:
 * - register writes the ready row and generates task_id/created_at once.
 * - beginDispatch atomically moves ready -> dispatching (single acquisition).
 * - markSubmitted atomically moves dispatching -> submitted.
 * - list* returns rows sorted by (created_at, contract_id).
 * - malformed/future-version/multi-state rows are preserved, audited, and stop.
 */

import { formatErr } from '../../foundation/node-utils/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ContractId } from '../contract/index.js';
import { makeContractId } from '../contract/index.js';
import type { FullTaskId } from '../async-task-system/index.js';
import { makeFullTaskId, adoptLegacyFullTaskId } from '../async-task-system/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';

const RETROSPECTIVES_DIR = `${CLAWSPACE_DIR}/evolution/retrospectives`;
export const READY_DIR = `${RETROSPECTIVES_DIR}/ready`;
export const DISPATCHING_DIR = `${RETROSPECTIVES_DIR}/dispatching`;
export const SUBMITTED_DIR = `${RETROSPECTIVES_DIR}/submitted`;
/**
 * Phase 1904 Step C: 跨 lifecycle 稳定身份 claim 目录。
 * claim 不随 ready→dispatching→submitted move，是同一 contractId
 * retrospective 身份的唯一原子创建点（RACE-RETRO-LIFECYCLE-CLAIM 治理）。
 */
export const CLAIMS_DIR = `${RETROSPECTIVES_DIR}/claims`;

/**
 * Phase 1206  legacy v1 行字段（含 summon mode / source task id）。
 * Phase 1396 Step M: 只读兼容；新 writer 不再写 v1。
 */
type RetrospectiveMode = 'mining' | 'shadow';

/** Phase 1396 Step M: active 观察输入 —— 只含已完成契约的稳定身份。 */
export interface EnsureRetrospectiveInput {
  contractId: ContractId;
  targetExecutorId: string;
}

interface RegisterRetrospectiveResult {
  taskId: FullTaskId;
  createdAt: string;
}

/** Legacy v1 row（只读）；新 writer 不再保存 summon 执行模式或 source task id。 */
export interface RetrospectiveWorkItemV1 {
  schema_version: 1;
  contract_id: ContractId;
  task_id: FullTaskId;
  target_claw: string;
  created_at: string;
  mode?: RetrospectiveMode;
  mining_task_id?: string;
  shadow_task_id?: string;
}

/** Phase 1396 Step M: active v2 row —— contract/executor/task identity only。 */
export interface RetrospectiveWorkItemV2 {
  schema_version: 2;
  contract_id: ContractId;
  task_id: FullTaskId;
  target_executor_id: string;
  created_at: string;
}

export type RetrospectiveWorkItem = RetrospectiveWorkItemV1 | RetrospectiveWorkItemV2;

/** 跨 schema 版本取 executor id（v1: target_claw / v2: target_executor_id）。 */
export function executorIdOf(item: RetrospectiveWorkItem): string {
  return item.schema_version === 2 ? item.target_executor_id : item.target_claw;
}

/**
 * Phase 1904 Step C: 稳定身份 claim。
 * 字段与 v2 row 同形 —— claim 即身份的唯一提交事实，row 可由其确定性重建。
 */
interface RetrospectiveIdentityClaim {
  schema_version: 1;
  contract_id: ContractId;
  task_id: FullTaskId;
  target_executor_id: string;
  created_at: string;
}

type ClaimReadResult =
  | { kind: 'absent' }
  | { kind: 'ok'; claim: RetrospectiveIdentityClaim }
  | { kind: 'corrupt'; reason: string };

type BeginDispatchDisposition = 'acquired' | 'submitted' | 'busy' | 'missing';

interface RetrospectiveStoreDeps {
  fs: FileSystem;
  audit: AuditLog;
  generateTaskId?: () => FullTaskId;
}

interface RowLocation {
  dir: 'ready' | 'dispatching' | 'submitted';
  path: string;
}

/**
 * Phase 1902 Step C: ensure 身份解析的有限重读次数。
 * winner row 被 beginDispatch/markSubmitted 在 find→read 窗口内移动时重读；
 * 超过次数由 caller 显式报 indeterminate，绝不静默重写新 task。
 */
const ENSURE_IDENTITY_SCAN_ATTEMPTS = 3;

/**
 * phase 1920: loser 读 claim 的半写窗口退让预算。O_EXCL 先发布路径再完成内容写，
 * live winner 的在途写入需要有限时间落笔——无延迟的立即重读在高负载下会耗尽预算、
 * 把正常并发误判为 indeterminate。解析失败带微延迟重读；超过预算仍不可解析
 * = 崩溃半写/真损坏，维持 fail-closed。
 */
const CLAIM_STABLE_READ_ATTEMPTS = 8;
const CLAIM_STABLE_READ_DELAY_MS = 5;

/**
 * Phase 1921 Step B: lifecycle row（ready/dispatching/submitted）的半写窗口退让
 * 预算（与 claim 同理：writeExclusive 先发布路径再落笔，loser 可读到位数
 * 不全的内容）。仅 JSON 解析失败退让——截断/半写绝不会产生结构合法但字段
 * 漂移的 JSON，schema 不符立即 corrupt 不退让；超预算仍不可解析 = 崩溃半写/
 * 真损坏，维持 fail-closed。
 */
const ROW_STABLE_READ_ATTEMPTS = 8;
const ROW_STABLE_READ_DELAY_MS = 5;

/** writeExclusive (O_EXCL) 冲突检测 —— 对称 contract/creation.ts 的本地 helper。 */
function isAlreadyExists(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

export class RetrospectiveStore {
  private readonly fs: FileSystem;
  private readonly audit: AuditLog;
  private readonly generateTaskId: () => FullTaskId;

  constructor(deps: RetrospectiveStoreDeps) {
    this.fs = deps.fs;
    this.audit = deps.audit;
    this.generateTaskId = deps.generateTaskId ?? (() => makeFullTaskId(crypto.randomUUID()));
  }

  private rowPath(contractId: ContractId, dir: RowLocation['dir']): string {
    const base = dir === 'ready' ? READY_DIR : dir === 'dispatching' ? DISPATCHING_DIR : SUBMITTED_DIR;
    return `${base}/${contractId}.json`;
  }

  async ensureDirs(): Promise<void> {
    await this.fs.ensureDir(READY_DIR);
    await this.fs.ensureDir(DISPATCHING_DIR);
    await this.fs.ensureDir(SUBMITTED_DIR);
    await this.fs.ensureDir(CLAIMS_DIR);
  }

  /**
   * Phase 1396 Step M: ensure a v2 retrospective work item for an observed
   * completed contract. Idempotent on producer input; fail-closed on
   * mismatched re-registration. New writes only persist contract/executor/task
   * identity (v2); existing v1 rows are matched read-only by (contractId,
   * executor) and never rewritten.
   *
   * Phase 1902 Step C: 首次注册改为 writeExclusive (O_EXCL) 磁盘裁决。
   *
   * Phase 1904 Step C（RACE-RETRO-LIFECYCLE-CLAIM 治理）：路径级 O_EXCL 在
   * winner row 被 move 腾空后会失效，因此身份裁决迁到不随 lifecycle move 的
   * 稳定 claim（claims/<contractId>.json，O_EXCL 创建）。row 只由 ensure 以
   * claim 身份写入，lifecycle move 不复制身份，故 beginDispatch/markSubmitted/
   * recovery 消费的 row 身份在创建点已被仲裁，无需重复校验。
   *
   * 提交协议与崩溃矩阵（claim 先行、row 后发布）：
   * - crash before claim：无事实；下次 ensure 重新裁决。
   * - crash during claim write（半写/空 claim）：loser 有限重读后仍不可解析
   *   → fail-closed 保留证据，绝不覆盖。
   * - crash after claim, before row：claim 为唯一身份事实；下次 ensure 由
   *   claim 重建 ready row（RETRO_CLAIM_ROW_REBUILT），身份不变。
   * - crash after row, before committed audit：row+claim 一致；下次 ensure
   *   replay，不补发 committed（宁可少一条 audit，不多一条身份事实）。
   * - 旧数据（无 claim 的 v1/v2 row）：首次 ensure 观察时一次性 O_EXCL 补建
   *   claim（RETRO_CLAIM_BACKFILLED）；并发补建 EEXIST 后重读比较，冲突
   *   保留证据并 fail-closed。
   */
  async ensure(input: EnsureRetrospectiveInput): Promise<RegisterRetrospectiveResult> {
    await this.ensureDirs();

    const resolved = await this._resolveExistingIdentity(input, false);
    if (resolved) {
      // replay 路径也核对/补建稳定 claim（旧 row 的一次性迁移点）。
      await this._reconcileClaimWithRow(input, resolved);
      return resolved;
    }

    const createdAt = new Date().toISOString();
    const taskId = this.generateTaskId();
    const claim: RetrospectiveIdentityClaim = {
      schema_version: 1,
      contract_id: input.contractId,
      task_id: taskId,
      target_executor_id: input.targetExecutorId,
      created_at: createdAt,
    };

    // 稳定 claim 是身份的唯一原子创建点；row 腾空的 ready 路径不再充当裁决。
    try {
      await this.fs.writeExclusive(this._claimPath(input.contractId), JSON.stringify(claim, null, 2));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return this._resolveClaimRace(input);
    }

    // claim 裁决成功 —— 以 claim 身份发布 ready row。
    const row: RetrospectiveWorkItemV2 = {
      schema_version: 2,
      contract_id: input.contractId,
      task_id: taskId,
      target_executor_id: input.targetExecutorId,
      created_at: createdAt,
    };
    try {
      await this.fs.writeExclusive(this.rowPath(input.contractId, 'ready'), JSON.stringify(row, null, 2));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      // 并发 claim 持有者/重建者已发布 row —— 重读并校验与本 claim 身份一致。
      return this._replayRowAgainstClaim(input, { taskId, createdAt });
    }

    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED,
      `contractId=${input.contractId}`,
      `taskId=${taskId}`,
    );

    return { taskId, createdAt };
  }

  /**
   * Phase 1904 Step C: claim O_EXCL 败者路径。读取 winner claim 并比较
   * producer input；winner row 未发布（崩溃窗口）时以 claim 身份重建。
   */
  private async _resolveClaimRace(input: EnsureRetrospectiveInput): Promise<RegisterRetrospectiveResult> {
    const read = await this._readClaimStable(input.contractId);
    if (read.kind !== 'ok') {
      // EEXIST 已证明 claim 存在过；读不到有效内容 = 半写/损坏/消失，fail-closed。
      const detail = read.kind === 'corrupt' ? `is corrupt (${read.reason})` : 'vanished after exclusive conflict';
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED,
        `contractId=${input.contractId}`,
        `state=claims`,
        `reason=ensure_claim_indeterminate`,
      );
      throw new Error(
        `Retrospective registration for ${input.contractId} is indeterminate: ` +
        `exclusive create conflicted but claim ${detail}`,
      );
    }

    const winnerClaim = read.claim;
    if (winnerClaim.target_executor_id !== input.targetExecutorId) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_REGISTRATION_CONFLICT,
        `contractId=${input.contractId}`,
        `state=claims`,
        `reason=producer_input_mismatch`,
      );
      throw new Error(`Retrospective registration conflict for ${input.contractId}`);
    }

    const existing = await this._resolveExistingIdentity(input, true);
    if (existing) {
      // row 已发布 —— 必须与 winner claim 同一身份。
      return this._assertRowMatchesClaim(input, existing, winnerClaim);
    }

    // 崩溃窗口：claim 已提交、row 从未发布 —— 以 claim 身份重建 ready row。
    const row: RetrospectiveWorkItemV2 = {
      schema_version: 2,
      contract_id: input.contractId,
      task_id: winnerClaim.task_id,
      target_executor_id: winnerClaim.target_executor_id,
      created_at: winnerClaim.created_at,
    };
    try {
      await this.fs.writeExclusive(this.rowPath(input.contractId, 'ready'), JSON.stringify(row, null, 2));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const raced = await this._resolveExistingIdentity(input, true);
      if (!raced) {
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED,
          `contractId=${input.contractId}`,
          `reason=ensure_identity_indeterminate`,
        );
        throw new Error(
          `Retrospective registration for ${input.contractId} is indeterminate: ` +
          `exclusive create conflicted but no row is readable`,
        );
      }
      return this._assertRowMatchesClaim(input, raced, winnerClaim);
    }

    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_CLAIM_ROW_REBUILT,
      `contractId=${input.contractId}`,
      `taskId=${winnerClaim.task_id}`,
    );
    return { taskId: winnerClaim.task_id, createdAt: winnerClaim.created_at };
  }

  /** claim 裁决成功后 ready row O_EXCL 败者路径：重读并校验与本 claim 一致。 */
  private async _replayRowAgainstClaim(
    input: EnsureRetrospectiveInput,
    claimIdentity: RegisterRetrospectiveResult,
  ): Promise<RegisterRetrospectiveResult> {
    const existing = await this._resolveExistingIdentity(input, true);
    if (!existing) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED,
        `contractId=${input.contractId}`,
        `reason=ensure_identity_indeterminate`,
      );
      throw new Error(
        `Retrospective registration for ${input.contractId} is indeterminate: ` +
        `exclusive create conflicted but no row is readable`,
      );
    }
    const row = this._assertRowMatchesClaim(input, existing, {
      schema_version: 1,
      contract_id: input.contractId,
      task_id: claimIdentity.taskId,
      target_executor_id: input.targetExecutorId,
      created_at: claimIdentity.createdAt,
    });
    // phase 1920：row 被同身份并发重建者抢先发布时，注册事实上仍由本 claim 代数提交。
    // 只有 claim O_EXCL 创建者能到达本路径（claim 永不删除、每 contract 至多创建一次），
    // 故恰好一次的 committed 登记在此补发，不多发、不缺席。
    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED,
      `contractId=${input.contractId}`,
      `taskId=${row.taskId}`,
    );
    return row;
  }

  private _assertRowMatchesClaim(
    input: EnsureRetrospectiveInput,
    row: RegisterRetrospectiveResult,
    claim: RetrospectiveIdentityClaim,
  ): RegisterRetrospectiveResult {
    // Phase 1908 Step C: 完整 identity binding —— claim 内容、row 与 ensure
    // 输入必须同时匹配 contract、executor、task、createdAt（RACE-RETRO-CLAIM-PATH-IDENTITY）。
    if (
      claim.contract_id !== input.contractId ||
      claim.target_executor_id !== input.targetExecutorId ||
      row.taskId !== claim.task_id ||
      row.createdAt !== claim.created_at
    ) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_REGISTRATION_CONFLICT,
        `contractId=${input.contractId}`,
        `reason=claim_row_identity_mismatch`,
      );
      throw new Error(`Retrospective claim/row identity mismatch for ${input.contractId}`);
    }
    return row;
  }

  /**
   * Phase 1904 Step C: replay 路径的 claim↔row 一致性核对与旧数据一次性迁移。
   * claim 缺失时以 row 身份 O_EXCL 补建（迁移只有一次，并发补建 EEXIST 后重读
   * 比较）；claim 存在时必须与 row 身份一致，冲突/损坏保留证据并 fail-closed。
   */
  private async _reconcileClaimWithRow(
    input: EnsureRetrospectiveInput,
    row: RegisterRetrospectiveResult,
  ): Promise<void> {
    const read = await this._readClaimStable(input.contractId);
    if (read.kind === 'ok') {
      this._assertRowMatchesClaim(input, row, read.claim);
      return;
    }
    if (read.kind === 'corrupt') {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
        `contractId=${input.contractId}`,
        `state=claims`,
        `reason=claim_${read.reason}`,
      );
      throw new Error(`Retrospective claim for ${input.contractId} exists but is corrupt`);
    }

    // claim 缺失 = 旧数据（v1/v2 row）—— 以 row 身份一次性补建。
    const claim: RetrospectiveIdentityClaim = {
      schema_version: 1,
      contract_id: input.contractId,
      task_id: row.taskId,
      target_executor_id: input.targetExecutorId,
      created_at: row.createdAt,
    };
    try {
      await this.fs.writeExclusive(this._claimPath(input.contractId), JSON.stringify(claim, null, 2));
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_CLAIM_BACKFILLED,
        `contractId=${input.contractId}`,
        `taskId=${row.taskId}`,
      );
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const reread = await this._readClaimStable(input.contractId);
      if (reread.kind !== 'ok') {
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
          `contractId=${input.contractId}`,
          `state=claims`,
          `reason=claim_backfill_race_unreadable`,
        );
        throw new Error(`Retrospective claim for ${input.contractId} exists but is corrupt`);
      }
      this._assertRowMatchesClaim(input, row, reread.claim);
    }
  }

  private _claimPath(contractId: ContractId): string {
    return `${CLAIMS_DIR}/${contractId}.json`;
  }

  /**
   * Phase 1904 Step C: 读取稳定 claim。writeExclusive 先发布路径再完成内容写，
   * loser 可能读到半写 JSON —— 解析失败带微延迟有限重读（phase 1920：退让给
   * 在途写入落笔时间）；schema 不符 / 超预算 = corrupt。
   */
  private async _readClaimStable(contractId: ContractId): Promise<ClaimReadResult> {
    const path = this._claimPath(contractId);
    for (let attempt = 0; attempt < CLAIM_STABLE_READ_ATTEMPTS; attempt++) {
      let raw: string;
      try {
        raw = await this.fs.read(path);
      } catch (err) {
        if (isFileNotFound(err)) return { kind: 'absent' };
        throw err;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 半写窗口 —— 退让后重读（live writer 有限时间内落笔；崩溃半写最终 fail-closed）
        if (attempt + 1 < CLAIM_STABLE_READ_ATTEMPTS) {
          await new Promise<void>((resolve) => { setTimeout(resolve, CLAIM_STABLE_READ_DELAY_MS); });
        }
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') {
        return { kind: 'corrupt', reason: 'not_an_object' };
      }
      const r = parsed as Record<string, unknown>;
      if (r.schema_version !== 1) {
        return { kind: 'corrupt', reason: 'unsupported_version' };
      }
      if (
        typeof r.contract_id !== 'string' ||
        typeof r.task_id !== 'string' ||
        typeof r.target_executor_id !== 'string' ||
        typeof r.created_at !== 'string'
      ) {
        return { kind: 'corrupt', reason: 'missing_required_fields' };
      }
      // Phase 1908 Step C: 路径 key 与内容 identity 绑定 —— 路径 A 的 claim
      // 携带 contract B 的内容一律 fail-closed（RACE-RETRO-CLAIM-PATH-IDENTITY）。
      if (r.contract_id !== contractId) {
        return { kind: 'corrupt', reason: 'path_identity_mismatch' };
      }
      return {
        kind: 'ok',
        claim: {
          schema_version: 1,
          contract_id: makeContractId(r.contract_id),
          task_id: adoptLegacyFullTaskId(r.task_id),
          target_executor_id: r.target_executor_id,
          created_at: r.created_at,
        },
      };
    }
    return { kind: 'corrupt', reason: 'invalid_json' };
  }

  /**
   * Phase 1902 Step C: 定位并匹配已存在 row。返回 null 表示各 lifecycle
   * 状态都没有该 contract 的 row（caller 可尝试 exclusive create）。
   * `mustExist=false`（首次扫描）空结果立即返回 null —— 由 writeExclusive 裁决；
   * `mustExist=true`（EEXIST 后重读）空结果有限重试，吸收 beginDispatch/
   * markSubmitted 的 move 窗口。corrupt/mismatch 维持 fail-closed。
   */
  private async _resolveExistingIdentity(input: EnsureRetrospectiveInput, mustExist: boolean): Promise<RegisterRetrospectiveResult | null> {
    for (let attempt = 0; attempt < ENSURE_IDENTITY_SCAN_ATTEMPTS; attempt++) {
      const existing = await this._findAnyRow(input.contractId);
      if (existing === null) {
        if (!mustExist) return null;
        continue; // 移动恰好落在逐状态 exists 间隙 —— 重读
      }
      const item = await this._readRow(existing.path, existing.dir);
      if (item === null) {
        if (!(await this.fs.exists(existing.path).catch(() => false))) {
          continue; // find→read 之间被 beginDispatch/markSubmitted 移动 —— 重读新位置
        }
        // corrupt existing row — preserve and stop
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
          `contractId=${input.contractId}`,
          `state=${existing.dir}`,
          `reason=register_existing_corrupt`,
        );
        throw new Error(`Retrospective row for ${input.contractId} exists but is corrupt`);
      }
      if (!observedInputMatchesRow(input, item)) {
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_STORE_REGISTRATION_CONFLICT,
          `contractId=${input.contractId}`,
          `state=${existing.dir}`,
          `reason=producer_input_mismatch`,
        );
        throw new Error(`Retrospective registration conflict for ${input.contractId}`);
      }
      return { taskId: item.task_id, createdAt: item.created_at };
    }
    return null;
  }

  /**
   * Acquire single-dispatch authority by atomically moving ready -> dispatching.
   * Returns typed disposition without throwing for business states.
   */
  async beginDispatch(contractId: ContractId): Promise<BeginDispatchDisposition> {
    await this.ensureDirs();

    // Fail-closed on multi-state before any single-state interpretation.
    await this._findAnyRow(contractId);

    const readyPath = this.rowPath(contractId, 'ready');
    const dispatchingPath = this.rowPath(contractId, 'dispatching');
    const submittedPath = this.rowPath(contractId, 'submitted');

    const [hasReady, hasDispatching, hasSubmitted] = await Promise.all([
      this.fs.exists(readyPath).catch(() => false),
      this.fs.exists(dispatchingPath).catch(() => false),
      this.fs.exists(submittedPath).catch(() => false),
    ]);

    if (hasSubmitted) return 'submitted';
    if (hasDispatching) return 'busy';
    if (!hasReady) return 'missing';

    // Pre-check dispatching target to avoid accidental overwrite by move.
    if (await this.fs.exists(dispatchingPath).catch(() => false)) {
      return 'busy';
    }

    try {
      await this.fs.move(readyPath, dispatchingPath);
    } catch (e) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_DISPATCH_MOVE_FAILED,
        `contractId=${contractId}`,
        `from=ready`,
        `to=dispatching`,
        `reason=${formatErr(e)}`,
      );
      // If move failed because target appeared concurrently, report busy.
      if (await this.fs.exists(dispatchingPath).catch(() => false)) {
        return 'busy';
      }
      throw e;
    }

    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_DISPATCH_STARTED,
      `contractId=${contractId}`,
    );
    return 'acquired';
  }

  async readDispatching(contractId: ContractId): Promise<RetrospectiveWorkItem | null> {
    const path = this.rowPath(contractId, 'dispatching');
    return this._readRow(path, 'dispatching');
  }

  async readSubmitted(contractId: ContractId): Promise<RetrospectiveWorkItem | null> {
    const path = this.rowPath(contractId, 'submitted');
    return this._readRow(path, 'submitted');
  }

  /**
   * Confirm submission by atomically moving dispatching -> submitted.
   *
   * Phase 1912 Step F: 并发同事实提交收敛。markSubmitted 只携带 contractId、
   * 无 payload 输入，同一 row 的并发 move 必然是同一事实；move 失败后按
   * 三态重读而非直接失败：
   *   - submitted 已存在   → winner 已把同一 row 落位 → 收敛为已提交；
   *   - dispatching 仍在   → winner 在途/瞬态（如 claim 身份重建补回 row）→
   *                           有限重试一次 move，再按三态收敛；
   *   - 两边皆无           → 事实未知 → fail-closed 留证抛错。
   * 非 ENOENT 失败（EPERM/EIO 等）维持原 audit + throw。
   *
   * 返回 typed outcome：'submitted'（本次 move 落位）/ 'already_submitted'
   * （幂等命中或并发收敛），caller 按语义呈现；事实未知仍 throw。
   */
  async markSubmitted(contractId: ContractId): Promise<'submitted' | 'already_submitted'> {
    const dispatchingPath = this.rowPath(contractId, 'dispatching');
    const submittedPath = this.rowPath(contractId, 'submitted');

    if (!(await this.fs.exists(dispatchingPath).catch(() => false))) {
      if (await this.fs.exists(submittedPath).catch(() => false)) {
        return 'already_submitted';
      }
      throw new Error(`Cannot mark submitted: no dispatching row for ${contractId}`);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.fs.move(dispatchingPath, submittedPath);
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_DISPATCH_SUBMITTED,
          `contractId=${contractId}`,
        );
        return 'submitted';
      } catch (e) {
        if (isFileNotFound(e)) {
          // winner 已落位同一事实 → 收敛成功
          if (await this.fs.exists(submittedPath).catch(() => false)) {
            this.audit.write(
              RETRO_AUDIT_EVENTS.RETRO_DISPATCH_SUBMITTED,
              `contractId=${contractId}`,
              'converged=already_submitted',
            );
            return 'already_submitted';
          }
          // dispatching 仍在 → winner 在途/瞬态 → 重试一次；否则落到 fail-closed
          if (attempt === 0 && (await this.fs.exists(dispatchingPath).catch(() => false))) {
            continue;
          }
          const notFoundError = new Error(
            `Cannot mark submitted: row vanished for ${contractId} (neither dispatching nor submitted)`,
          );
          this.audit.write(
            RETRO_AUDIT_EVENTS.RETRO_DISPATCH_SUBMITTED_FAILED,
            `contractId=${contractId}`,
            `reason=${formatErr(notFoundError)}`,
          );
          throw notFoundError;
        }
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_DISPATCH_SUBMITTED_FAILED,
          `contractId=${contractId}`,
          `reason=${formatErr(e)}`,
        );
        throw e;
      }
    }

    // 不可达：循环内每条路径均 return/throw；仅为满足 TS 结束返回检查。
    throw new Error(`Cannot mark submitted: unexpected retry exhaustion for ${contractId}`);
  }

  async listReady(): Promise<RetrospectiveWorkItem[]> {
    return this._listDir('ready');
  }

  async listDispatching(): Promise<RetrospectiveWorkItem[]> {
    return this._listDir('dispatching');
  }

  async listSubmitted(): Promise<RetrospectiveWorkItem[]> {
    return this._listDir('submitted');
  }

  private async _listDir(dir: RowLocation['dir']): Promise<RetrospectiveWorkItem[]> {
    const base = dir === 'ready' ? READY_DIR : dir === 'dispatching' ? DISPATCHING_DIR : SUBMITTED_DIR;
    let entries: Awaited<ReturnType<FileSystem['list']>>;
    try {
      entries = await this.fs.list(base, { includeDirs: false });
    } catch (err) {
      if (isFileNotFound(err)) return [];
      throw err;
    }

    const items: RetrospectiveWorkItem[] = [];
    for (const e of entries) {
      if (!e.name.endsWith('.json')) continue;
      const contractId = makeContractId(e.name.replace(/\.json$/, ''));
      const item = await this._readRow(`${base}/${e.name}`, dir);
      if (item) {
        items.push(item);
      } else {
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
          `contractId=${contractId}`,
          `state=${dir}`,
          `reason=list_read_failed`,
        );
      }
    }

    items.sort((a, b) => {
      const cmp = a.created_at.localeCompare(b.created_at);
      return cmp !== 0 ? cmp : a.contract_id.localeCompare(b.contract_id);
    });
    return items;
  }

  private async _findAnyRow(contractId: ContractId): Promise<RowLocation | null> {
    const candidates: RowLocation[] = [
      { dir: 'ready', path: this.rowPath(contractId, 'ready') },
      { dir: 'dispatching', path: this.rowPath(contractId, 'dispatching') },
      { dir: 'submitted', path: this.rowPath(contractId, 'submitted') },
    ];

    const found: RowLocation[] = [];
    for (const c of candidates) {
      if (await this.fs.exists(c.path).catch(() => false)) {
        found.push(c);
      }
    }

    if (found.length > 1) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_MULTI_STATE,
        `contractId=${contractId}`,
        `states=${found.map(f => f.dir).join(';')}`,
      );
      throw new Error(`Retrospective row for ${contractId} exists in multiple states`);
    }

    return found[0] ?? null;
  }

  /**
   * Phase 1921 Step B: 稳定读取 row。writeExclusive 先发布路径再完成内容写，
   * find→read 窗口内 loser 可能读到半写 JSON——解析失败带微延迟有限重读
   * （退让给在途写入落笔）；I/O 错误、schema 不符不退让，超预算仍不可解析
   * = 崩溃半写/真损坏，audit + null（caller 维持 fail-closed）。
   */
  private async _readRow(path: string, dir: RowLocation['dir']): Promise<RetrospectiveWorkItem | null> {
    let parsed: unknown = null;
    let parseOk = false;
    for (let attempt = 0; attempt < ROW_STABLE_READ_ATTEMPTS; attempt++) {
      let raw: string;
      try {
        raw = await this.fs.read(path);
      } catch (err) {
        if (isFileNotFound(err)) return null;
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED,
          `path=${path}`,
          `state=${dir}`,
          `reason=${formatErr(err)}`,
        );
        return null;
      }

      try {
        parsed = JSON.parse(raw);
        parseOk = true;
        break;
      } catch {
        // silent: 半写窗口退让后重读——live writer 有限时间内落笔；超预算由循环外
        // invalid_json corrupt 显式登记（崩溃半写/真损坏 fail-closed），此处非吞错
        if (attempt + 1 < ROW_STABLE_READ_ATTEMPTS) {
          await new Promise<void>((resolve) => { setTimeout(resolve, ROW_STABLE_READ_DELAY_MS); });
        }
      }
    }
    if (!parseOk) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
        `path=${path}`,
        `state=${dir}`,
        `reason=invalid_json`,
      );
      return null;
    }

    if (parsed === null || typeof parsed !== 'object') {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
        `path=${path}`,
        `state=${dir}`,
        `reason=not_an_object`,
      );
      return null;
    }

    const r = parsed as Record<string, unknown>;
    const version = r.schema_version;

    if (version === 2) {
      if (
        typeof r.contract_id !== 'string' ||
        typeof r.task_id !== 'string' ||
        typeof r.target_executor_id !== 'string' ||
        typeof r.created_at !== 'string'
      ) {
        this.audit.write(
          RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
          `path=${path}`,
          `state=${dir}`,
          `reason=missing_required_fields`,
        );
        return null;
      }
      return {
        schema_version: 2,
        contract_id: makeContractId(r.contract_id),
        task_id: adoptLegacyFullTaskId(r.task_id), // phase 1863 (AT-D11)：历史 retro 记录 task_id 宽容采纳
        target_executor_id: r.target_executor_id,
        created_at: r.created_at,
      };
    }

    if (version !== 1) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_FUTURE_VERSION,
        `path=${path}`,
        `state=${dir}`,
        `version=${version}`,
      );
      return null;
    }

    // v1 legacy read-only path
    if (
      typeof r.contract_id !== 'string' ||
      typeof r.task_id !== 'string' ||
      typeof r.target_claw !== 'string' ||
      typeof r.created_at !== 'string'
    ) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
        `path=${path}`,
        `state=${dir}`,
        `reason=missing_required_fields`,
      );
      return null;
    }

    return {
      schema_version: 1,
      contract_id: makeContractId(r.contract_id),
      task_id: adoptLegacyFullTaskId(r.task_id), // phase 1863 (AT-D11)：历史 retro 记录 task_id 宽容采纳
      target_claw: r.target_claw,
      created_at: r.created_at,
      mode: r.mode === 'mining' || r.mode === 'shadow' ? r.mode : undefined,
      mining_task_id: typeof r.mining_task_id === 'string' ? r.mining_task_id : undefined,
      shadow_task_id: typeof r.shadow_task_id === 'string' ? r.shadow_task_id : undefined,
    };
  }
}

/**
 * Phase 1396 Step M: producer input 按各自 schema 比较 ——
 * v2 行比 (contract_id, target_executor_id)；v1 legacy 行比 (contract_id, target_claw)。
 */
function observedInputMatchesRow(input: EnsureRetrospectiveInput, item: RetrospectiveWorkItem): boolean {
  return input.contractId === item.contract_id && executorIdOf(item) === input.targetExecutorId;
}
