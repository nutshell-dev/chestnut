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

import { formatErr, sha256Hex } from '../../foundation/node-utils/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ContractId } from '../contract/index.js';
import { makeContractId } from '../contract/index.js';
import type { FullTaskId } from '../async-task-system/index.js';
import { makeFullTaskId, adoptLegacyFullTaskId } from '../async-task-system/index.js';
import { CLAWSPACE_DIR } from '../../foundation/claw-identity/index.js';
import { RETRO_AUDIT_EVENTS } from './retro-audit-events.js';
import type { ArchivedOrphanEvidence, ArchivedOrphanOutcome, OrphanDisposition } from './types.js';

const RETROSPECTIVES_DIR = `${CLAWSPACE_DIR}/evolution/retrospectives`;
export const READY_DIR = `${RETROSPECTIVES_DIR}/ready`;
export const DISPATCHING_DIR = `${RETROSPECTIVES_DIR}/dispatching`;
export const SUBMITTED_DIR = `${RETROSPECTIVES_DIR}/submitted`;
export const RETIRED_DIR = `${RETROSPECTIVES_DIR}/retired`;
export const ORPHAN_OUTCOMES_DIR = `${RETROSPECTIVES_DIR}/orphan-outcomes`;
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
  | { kind: 'creating'; intent?: RetrospectiveIdentityClaim }
  | { kind: 'ok'; claim: RetrospectiveIdentityClaim }
  | { kind: 'corrupt'; reason: string };

type ClaimFileReadResult = Exclude<ClaimReadResult, { kind: 'creating' }>;

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
 * Phase 2155 Step B5: creating marker 尚无 intent、或 legacy claim 半写时的
 * 有界观察预算。新 writer 的 intent/final 均 writeAtomic，路径首次可见即完整；
 * creating 不再被归为 absent/corrupt，超过预算仍无 intent 则 indeterminate，
 * 保留 marker 供人工恢复，绝不按时间自动删除或另建身份。
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
   * Phase 2155 Step B5：claims/<id>.creating/ 的原子 mkdir 取得身份创建权；
   * creator 先原子写 intent.json，再原子发布 final claim，最后清理 marker。
   * loser 可将 creating/intent 恢复为 final，但绝不把 creating 当 absent/corrupt
   * 或另建 task identity。row 只由 final/intent 中的稳定身份发布。
   *
   * 崩溃矩阵：marker 后无 intent → 有界观察后 indeterminate 并保留人工恢复
   * 证据；intent 后无 final → 由 intent 完成发布；final 后无 row → 重建 ready
   * row；row 后无 committed audit → replay 不补发，避免重复身份事实。legacy
   * final/row 保持只读兼容，迁移不得覆盖既有 final。
   */
  async ensure(input: EnsureRetrospectiveInput): Promise<RegisterRetrospectiveResult> {
    await this.ensureDirs();

    const resolved = await this._resolveExistingIdentity(input, false);
    if (resolved) {
      // replay 路径也核对/补建稳定 claim（旧 row 的一次性迁移点）。
      await this._reconcileClaimWithRow(input, resolved);
      return resolved;
    }

    // 在生成随机身份前先观察 final/creating：恢复只采用已持久化身份。
    const observed = await this._readClaimStable(input.contractId);
    if (observed.kind !== 'absent') {
      return this._resolveClaimObservation(input, observed);
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

    // 目录 mkdir 是身份创建权的唯一原子裁决点；final JSON 不再承担锁语义。
    try {
      this.fs.mkdirExclusiveSync(this._claimCreatingPath(input.contractId));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return this._resolveClaimRace(input);
    }

    const publication = await this._publishNewClaim(claim);
    if (!publication.created) {
      // 旧 final claim 已在 marker 裁决前存在：采用其身份，绝不写入候选身份。
      return this._resolveRowFromClaim(input, publication.claim);
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

  /** marker EEXIST 败者路径：final 优先；creating 只能由 intent 恢复或显式 indeterminate。 */
  private async _resolveClaimRace(input: EnsureRetrospectiveInput): Promise<RegisterRetrospectiveResult> {
    return this._resolveClaimObservation(input, await this._readClaimStable(input.contractId));
  }

  private async _resolveClaimObservation(
    input: EnsureRetrospectiveInput,
    read: ClaimReadResult,
  ): Promise<RegisterRetrospectiveResult> {
    if (read.kind === 'ok') {
      await this._cleanupClaimMarker(input.contractId);
      return this._resolveRowFromClaim(input, read.claim);
    }
    if (read.kind === 'creating' && read.intent) {
      this._assertClaimMatchesInput(input, read.intent);
      await this._publishFinalClaim(read.intent);
      await this._cleanupClaimMarker(input.contractId);
      return this._resolveRowFromClaim(input, read.intent);
    }

    const detail = read.kind === 'corrupt'
      ? `is corrupt (${read.reason})`
      : read.kind === 'creating'
        ? 'is still creating without a readable intent'
        : 'vanished after exclusive conflict';
    if (read.kind === 'corrupt') this._auditClaimCorrupt(input.contractId, read.reason);
    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED,
      `contractId=${input.contractId}`,
      `state=claims`,
      `reason=ensure_claim_indeterminate`,
    );
    throw new Error(
      `Retrospective registration for ${input.contractId} is indeterminate: claim ${detail}`,
    );
  }

  /**
   * marker 持有者的发布路径。若 legacy final 已存在则只采用、不覆盖；否则依次
   * 原子发布 intent/final。任何写失败都保留当前阶段证据供下次 ensure 恢复。
   */
  private async _publishNewClaim(
    claim: RetrospectiveIdentityClaim,
  ): Promise<{ claim: RetrospectiveIdentityClaim; created: boolean }> {
    const existing = await this._readClaimFile(this._claimPath(claim.contract_id), claim.contract_id);
    if (existing.kind === 'ok') {
      await this._cleanupClaimMarker(claim.contract_id);
      return { claim: existing.claim, created: false };
    }
    if (existing.kind === 'corrupt') {
      this._auditClaimCorrupt(claim.contract_id, existing.reason);
      throw new Error(`Retrospective claim for ${claim.contract_id} exists but is corrupt`);
    }

    const serialized = JSON.stringify(claim, null, 2);
    await this.fs.writeAtomic(this._claimIntentPath(claim.contract_id), serialized);
    await this.fs.writeAtomic(this._claimPath(claim.contract_id), serialized);
    await this._cleanupClaimMarker(claim.contract_id);
    return { claim, created: true };
  }

  /** creating/intent 恢复：final 若已被其他恢复者发布，必须逐字段同身份。 */
  private async _publishFinalClaim(claim: RetrospectiveIdentityClaim): Promise<void> {
    const existing = await this._readClaimFile(this._claimPath(claim.contract_id), claim.contract_id);
    if (existing.kind === 'corrupt') {
      this._auditClaimCorrupt(claim.contract_id, existing.reason);
      throw new Error(`Retrospective claim for ${claim.contract_id} exists but is corrupt`);
    }
    if (existing.kind === 'ok') {
      this._assertSameClaim(claim, existing.claim);
      return;
    }
    await this.fs.writeAtomic(this._claimPath(claim.contract_id), JSON.stringify(claim, null, 2));
  }

  private async _resolveRowFromClaim(
    input: EnsureRetrospectiveInput,
    winnerClaim: RetrospectiveIdentityClaim,
  ): Promise<RegisterRetrospectiveResult> {
    this._assertClaimMatchesInput(input, winnerClaim);
    const existing = await this._resolveExistingIdentity(input, true);
    if (existing) {
      return this._assertRowMatchesClaim(input, existing, winnerClaim);
    }

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

  private _assertClaimMatchesInput(input: EnsureRetrospectiveInput, claim: RetrospectiveIdentityClaim): void {
    if (claim.contract_id === input.contractId && claim.target_executor_id === input.targetExecutorId) return;
    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_STORE_REGISTRATION_CONFLICT,
      `contractId=${input.contractId}`,
      `state=claims`,
      `reason=producer_input_mismatch`,
    );
    throw new Error(`Retrospective registration conflict for ${input.contractId}`);
  }

  private _assertSameClaim(expected: RetrospectiveIdentityClaim, actual: RetrospectiveIdentityClaim): void {
    if (
      expected.contract_id === actual.contract_id &&
      expected.task_id === actual.task_id &&
      expected.target_executor_id === actual.target_executor_id &&
      expected.created_at === actual.created_at
    ) return;
    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_STORE_REGISTRATION_CONFLICT,
      `contractId=${expected.contract_id}`,
      `state=claims`,
      `reason=claim_identity_mismatch`,
    );
    throw new Error(`Retrospective claim identity mismatch for ${expected.contract_id}`);
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
    // row 被同身份并发重建者抢先发布时，注册事实上仍由本 claim 代数提交。
    // 只有 creating marker 创建者能到达本路径，故 committed 恰好补发一次。
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

  /** replay 的 claim↔row 核对，以及旧 row 经同一 creating/intent/final 协议补建。 */
  private async _reconcileClaimWithRow(
    input: EnsureRetrospectiveInput,
    row: RegisterRetrospectiveResult,
  ): Promise<void> {
    const read = await this._readClaimStable(input.contractId);
    if (read.kind !== 'absent') {
      await this._reconcileClaimObservation(input, row, read);
      return;
    }

    const claim: RetrospectiveIdentityClaim = {
      schema_version: 1,
      contract_id: input.contractId,
      task_id: row.taskId,
      target_executor_id: input.targetExecutorId,
      created_at: row.createdAt,
    };
    try {
      this.fs.mkdirExclusiveSync(this._claimCreatingPath(input.contractId));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      await this._reconcileClaimObservation(input, row, await this._readClaimStable(input.contractId));
      return;
    }

    const publication = await this._publishNewClaim(claim);
    this._assertRowMatchesClaim(input, row, publication.claim);
    if (publication.created) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_CLAIM_BACKFILLED,
        `contractId=${input.contractId}`,
        `taskId=${row.taskId}`,
      );
    }
  }

  private async _reconcileClaimObservation(
    input: EnsureRetrospectiveInput,
    row: RegisterRetrospectiveResult,
    read: ClaimReadResult,
  ): Promise<void> {
    if (read.kind === 'ok') {
      this._assertRowMatchesClaim(input, row, read.claim);
      await this._cleanupClaimMarker(input.contractId);
      return;
    }
    if (read.kind === 'creating' && read.intent) {
      this._assertRowMatchesClaim(input, row, read.intent);
      await this._publishFinalClaim(read.intent);
      await this._cleanupClaimMarker(input.contractId);
      return;
    }
    if (read.kind === 'corrupt') {
      this._auditClaimCorrupt(input.contractId, read.reason);
      throw new Error(`Retrospective claim for ${input.contractId} exists but is corrupt`);
    }

    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED,
      `contractId=${input.contractId}`,
      `state=claims`,
      `reason=claim_backfill_indeterminate`,
    );
    throw new Error(`Retrospective claim for ${input.contractId} is indeterminate`);
  }

  private _claimPath(contractId: ContractId): string {
    return `${CLAIMS_DIR}/${contractId}.json`;
  }

  private _claimCreatingPath(contractId: ContractId): string {
    return `${CLAIMS_DIR}/${contractId}.creating`;
  }

  private _claimIntentPath(contractId: ContractId): string {
    return `${this._claimCreatingPath(contractId)}/intent.json`;
  }

  private _auditClaimCorrupt(contractId: ContractId, reason: string): void {
    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_STORE_CORRUPT,
      `contractId=${contractId}`,
      `state=claims`,
      `reason=claim_${reason}`,
    );
  }

  /** final 已提交后清理仅为收敛；失败不影响身份，单独审计并保留现场。 */
  private async _cleanupClaimMarker(contractId: ContractId): Promise<void> {
    try {
      await this.fs.removeDir(this._claimCreatingPath(contractId));
    } catch (err) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_STORE_READ_FAILED,
        `contractId=${contractId}`,
        `state=claims`,
        `reason=claim_marker_cleanup_failed`,
        `error=${formatErr(err)}`,
      );
    }
  }

  /**
   * final → creating/intent 的 typed 观察。final 缺失且 marker 也缺失时重读
   * final，关闭「final 发布后、marker 清理前」被误判 absent 的窗口。
   * legacy final 的 invalid_json 保留有界退让；永久损坏原样保留并 fail-closed。
   */
  private async _readClaimStable(contractId: ContractId): Promise<ClaimReadResult> {
    let last: ClaimReadResult = { kind: 'absent' };
    for (let attempt = 0; attempt < CLAIM_STABLE_READ_ATTEMPTS; attempt++) {
      const final = await this._readClaimFile(this._claimPath(contractId), contractId);
      if (final.kind === 'ok') return final;
      if (final.kind === 'corrupt') {
        last = final;
        if (final.reason !== 'invalid_json') return final;
      } else {
        if (!(await this.fs.exists(this._claimCreatingPath(contractId)))) {
          const recheck = await this._readClaimFile(this._claimPath(contractId), contractId);
          return recheck.kind === 'absent' ? { kind: 'absent' } : recheck;
        }
        const intent = await this._readClaimFile(this._claimIntentPath(contractId), contractId);
        if (intent.kind === 'corrupt') {
          return { kind: 'corrupt', reason: `intent_${intent.reason}` };
        }
        last = intent.kind === 'ok'
          ? { kind: 'creating', intent: intent.claim }
          : { kind: 'creating' };
      }
      if (attempt + 1 < CLAIM_STABLE_READ_ATTEMPTS) {
        await new Promise<void>((resolve) => { setTimeout(resolve, CLAIM_STABLE_READ_DELAY_MS); });
      }
    }
    return last;
  }

  private async _readClaimFile(path: string, contractId: ContractId): Promise<ClaimFileReadResult> {
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
      // silent: 解析失败转换为 typed corrupt，由调用方审计并 fail-closed。
      return { kind: 'corrupt', reason: 'invalid_json' };
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

  /**
   * Retire a dispatching row only after its archived-completed outcome is durable.
   * The move preserves the original row bytes; an existing outcome is adopted only
   * when it proves the same row and archive fact. This makes boot replay and
   * concurrent reconciliation converge without deleting the source evidence.
   */
  async retireArchivedOrphan(
    item: RetrospectiveWorkItem,
    evidence: ArchivedOrphanEvidence,
  ): Promise<Extract<OrphanDisposition, { kind: 'retired_archived' | 'already_retired' }>> {
    await this.fs.ensureDir(RETIRED_DIR);
    await this.fs.ensureDir(ORPHAN_OUTCOMES_DIR);

    const contractId = item.contract_id;
    const dispatchingPath = this.rowPath(contractId, 'dispatching');
    const retiredPath = `${RETIRED_DIR}/${contractId}.json`;
    const outcomePath = `${ORPHAN_OUTCOMES_DIR}/${contractId}.json`;
    const [hasDispatching, hasRetired] = await Promise.all([
      this.fs.exists(dispatchingPath),
      this.fs.exists(retiredPath),
    ]);

    if (hasDispatching && hasRetired) {
      throw new Error(`Archived retrospective orphan for ${contractId} exists in both dispatching and retired`);
    }
    if (!hasDispatching) {
      if (!hasRetired) {
        throw new Error(`Cannot retire archived retrospective orphan: no dispatching row for ${contractId}`);
      }
      const committed = await this.readOrphanOutcome(contractId);
      if (!committed || committed.outcome !== 'retired_archived') {
        throw new Error(`Retired retrospective orphan for ${contractId} has no committed outcome`);
      }
      return { kind: 'already_retired', outcomePath };
    }

    const dispatchingBytes = await this.fs.read(dispatchingPath);
    const dispatchingSha256 = sha256Hex(dispatchingBytes);
    const candidate: ArchivedOrphanOutcome = {
      schema_version: 1,
      outcome: 'retired_archived',
      contract_id: contractId,
      task_id: item.task_id,
      target_executor_id: executorIdOf(item),
      created_at: item.created_at,
      contract_ref: `${evidence.archivePath}/contract.yaml`,
      archive_path: evidence.archivePath,
      completed_at: evidence.completedAt,
      observed_at: new Date().toISOString(),
      observation_source: 'contract_terminal_fact',
      dispatching_path: dispatchingPath,
      dispatching_sha256: dispatchingSha256,
      dispatching_bytes: dispatchingBytes,
      cause: evidence.cause ?? null,
    };

    let outcome = candidate;
    try {
      await this.fs.writeExclusive(outcomePath, JSON.stringify(candidate, null, 2));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      const existing = await this.readOrphanOutcome(contractId);
      if (!existing) {
        throw new Error(`Archived retrospective orphan outcome for ${contractId} is not readable after EEXIST`);
      }
      this._assertMatchingOrphanOutcome(candidate, existing);
      outcome = existing;
    }

    try {
      await this.fs.move(dispatchingPath, retiredPath);
    } catch (err) {
      if (await this.fs.exists(retiredPath).catch(() => false)) {
        return { kind: 'already_retired', outcomePath };
      }
      throw err;
    }

    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_ORPHAN_ARCHIVED,
      `contractId=${contractId}`,
      `contractRef=${outcome.contract_ref}`,
      `archivePath=${outcome.archive_path}`,
      `outcomePath=${outcomePath}`,
      `dispatchingSha256=${outcome.dispatching_sha256}`,
      `previousEvent=${RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED}`,
    );
    return { kind: 'retired_archived', outcomePath };
  }

  async readOrphanOutcome(contractId: ContractId): Promise<ArchivedOrphanOutcome | null> {
    const path = `${ORPHAN_OUTCOMES_DIR}/${contractId}.json`;
    let raw: string;
    try {
      raw = await this.fs.read(path);
    } catch (err) {
      if (isFileNotFound(err)) return null;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Archived retrospective orphan outcome for ${contractId} is corrupt: ${formatErr(err)}`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`Archived retrospective orphan outcome for ${contractId} is not an object`);
    }
    const value = parsed as Record<string, unknown>;
    if (
      value.schema_version !== 1 ||
      value.outcome !== 'retired_archived' ||
      value.contract_id !== contractId ||
      typeof value.task_id !== 'string' ||
      typeof value.target_executor_id !== 'string' ||
      typeof value.created_at !== 'string' ||
      typeof value.contract_ref !== 'string' ||
      typeof value.archive_path !== 'string' ||
      !(typeof value.completed_at === 'string' || value.completed_at === null) ||
      typeof value.observed_at !== 'string' ||
      value.observation_source !== 'contract_terminal_fact' ||
      typeof value.dispatching_path !== 'string' ||
      typeof value.dispatching_sha256 !== 'string' ||
      typeof value.dispatching_bytes !== 'string' ||
      !(typeof value.cause === 'string' || value.cause === null)
    ) {
      throw new Error(`Archived retrospective orphan outcome for ${contractId} has an invalid schema`);
    }
    const outcome = value as unknown as ArchivedOrphanOutcome;
    if (sha256Hex(outcome.dispatching_bytes) !== outcome.dispatching_sha256) {
      throw new Error(`Archived retrospective orphan outcome for ${contractId} has a row hash mismatch`);
    }
    return outcome;
  }

  private _assertMatchingOrphanOutcome(
    expected: ArchivedOrphanOutcome,
    actual: ArchivedOrphanOutcome,
  ): void {
    if (
      expected.contract_id !== actual.contract_id ||
      expected.task_id !== actual.task_id ||
      expected.target_executor_id !== actual.target_executor_id ||
      expected.created_at !== actual.created_at ||
      expected.contract_ref !== actual.contract_ref ||
      expected.archive_path !== actual.archive_path ||
      expected.completed_at !== actual.completed_at ||
      expected.dispatching_path !== actual.dispatching_path ||
      expected.dispatching_sha256 !== actual.dispatching_sha256 ||
      expected.dispatching_bytes !== actual.dispatching_bytes
    ) {
      throw new Error(`Archived retrospective orphan outcome identity mismatch for ${expected.contract_id}`);
    }
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
