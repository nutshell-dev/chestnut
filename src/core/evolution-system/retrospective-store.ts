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
  }

  /**
   * Phase 1396 Step M: ensure a v2 retrospective work item for an observed
   * completed contract. Idempotent on producer input; fail-closed on
   * mismatched re-registration. New writes only persist contract/executor/task
   * identity (v2); existing v1 rows are matched read-only by (contractId,
   * executor) and never rewritten.
   *
   * Phase 1902 Step C: 首次注册改为 writeExclusive (O_EXCL) 磁盘裁决 ——
   * 并发首次注册同一 contract 只产生一个 durable row、一个 task identity、
   * 一条 committed 事实；EEXIST loser 重读 winner 身份 replay，绝不覆盖。
   */
  async ensure(input: EnsureRetrospectiveInput): Promise<RegisterRetrospectiveResult> {
    await this.ensureDirs();

    const resolved = await this._resolveExistingIdentity(input, false);
    if (resolved) return resolved;

    const createdAt = new Date().toISOString();
    const taskId = this.generateTaskId();
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
      // Lost the exclusive-create race: winner 的 row 已 durable，重读 replay 其身份。
      const winner = await this._resolveExistingIdentity(input, true);
      if (winner) return winner;
      // writeExclusive 已证明 row 存在过；读不到 = 持续移动/消失，显式 indeterminate。
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

    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_REGISTRATION_COMMITTED,
      `contractId=${input.contractId}`,
      `taskId=${taskId}`,
    );

    return { taskId, createdAt };
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
   */
  async markSubmitted(contractId: ContractId): Promise<void> {
    const dispatchingPath = this.rowPath(contractId, 'dispatching');
    const submittedPath = this.rowPath(contractId, 'submitted');

    if (!(await this.fs.exists(dispatchingPath).catch(() => false))) {
      if (await this.fs.exists(submittedPath).catch(() => false)) {
        return; // already submitted
      }
      throw new Error(`Cannot mark submitted: no dispatching row for ${contractId}`);
    }

    try {
      await this.fs.move(dispatchingPath, submittedPath);
    } catch (e) {
      this.audit.write(
        RETRO_AUDIT_EVENTS.RETRO_DISPATCH_SUBMITTED_FAILED,
        `contractId=${contractId}`,
        `reason=${formatErr(e)}`,
      );
      throw e;
    }

    this.audit.write(
      RETRO_AUDIT_EVENTS.RETRO_DISPATCH_SUBMITTED,
      `contractId=${contractId}`,
    );
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

  private async _readRow(path: string, dir: RowLocation['dir']): Promise<RetrospectiveWorkItem | null> {
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
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
