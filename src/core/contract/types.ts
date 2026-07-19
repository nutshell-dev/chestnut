/**
 * @module L4.ContractSystem.Types
 * ContractSystem 内部 types 集中
 */

import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

// phase 64: ContractId brand 迁回（自 foundation/identity 解散）— 注释 admit
// 「物理迁自 core/contract/types.ts」(phase 1378)
// per M#3 资源唯一归属（按业务真实归属）+ M#1 contract lifecycle 独立可变
declare const ContractIdBrand: unique symbol;
export type ContractId = string & { readonly [ContractIdBrand]: true };
export function makeContractId(s: string): ContractId { return s as ContractId; }
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { Priority } from '../../foundation/messaging/index.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';
import { z } from 'zod';




// ============================================================================
// Contract domain types (canonical owner per interfaces/l4.md)
// ============================================================================

// Step F: current lifecycle is path-derived (active / archive/<state>); the only
// runtime aggregate status is DerivableStatus (pending/running/completed).
// Legacy flat-archive literals are kept only in LEGACY_PROGRESS_STATUSES_TUPLE for
// read-only historical parsing by the legacy adapter.

// phase 362: SubtaskStatus 改 derive from tuple (ML#1 共用基础设施单源、mirror DerivableStatus pattern)
// re-export tuple 保 backward compat 既有 import path
export { SUBTASK_STATUSES_TUPLE } from './status-tuples.js';
import { SUBTASK_STATUSES_TUPLE } from './status-tuples.js';

export type SubtaskStatus = (typeof SUBTASK_STATUSES_TUPLE)[number];

/**
 * phase 362: typed Set derive from tuple (mirror DERIVABLE_STATUSES、ML#1 单源 + ML#9 typed Set)
 */
export const SUBTASK_STATUSES: ReadonlySet<SubtaskStatus> = new Set(SUBTASK_STATUSES_TUPLE);

export interface LastFailedFeedback {
  feedback: string;
  cause: 'llm_rejected' | 'programming_bug' | 'subagent_timeout' | 'script_failed';
}

export interface AcceptanceFailedNotification {
  contract_id: ContractId;
  subtask_id: string;
  cause: 'llm_rejected' | 'programming_bug' | 'subagent_timeout' | 'script_failed';
  feedback: string;
  retry_count: number;
  max_attempts: number;
}

export interface SubTask {
  id: string;
  description: string;
  status: SubtaskStatus;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface Contract {
  id: string;
  title: string;
  description: string;
  status: DerivableStatus;
  priority: Priority;
  creator: string;
  goal: string;
  subtasks: SubTask[];
  auth_level: 'auto' | 'notify' | 'confirm';
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
}

// YAML contract file structure (exported for CLI use).
// phase 311: type derive from Zod schema (ML#9 优先编译器检查)
import type {
  ContractYamlValidated,
  ContractProgressPersistedValidated,
  PersistedContractYamlSchema,
  SubtaskRuntimeRecordSchema,
  VerificationAttemptRecordSchema,
} from './schemas.js';
export type ContractYaml = ContractYamlValidated;

// Phase 1134: new-layout schema-derived types
export type PersistedContractYaml = z.infer<typeof PersistedContractYamlSchema>;
export type SubtaskRuntimeRecord = z.infer<typeof SubtaskRuntimeRecordSchema>;
export type VerificationAttemptRecord = z.infer<typeof VerificationAttemptRecordSchema>;
import {
  SUBTASK_RUNTIME_STATUSES_TUPLE,
  VERIFICATION_ATTEMPT_STATUSES_TUPLE,
} from './status-tuples.js';
export type SubtaskRuntimeStatus = (typeof SUBTASK_RUNTIME_STATUSES_TUPLE)[number];
export type VerificationAttemptStatus = (typeof VERIFICATION_ATTEMPT_STATUSES_TUPLE)[number];

// phase 282 Step B: 落盘 schema（不含 derive field）
// phase 319: type derive from Zod schema (ML#9 优先编译器检查、broaden phase 311 pattern)
export type ProgressDataPersisted = ContractProgressPersistedValidated;

// Progress data structure（运行时 schema：derive fields 由 loader 注入）
// Step F: progress.json no longer carries lifecycle status. The runtime aggregate
// status is derived from subtasks and is strictly DerivableStatus.
export interface ProgressData extends Omit<ProgressDataPersisted, 'status'> {
  contract_id: ContractId;   // phase 282 Step B: derive from caller/dir
  status: DerivableStatus;   // Step F: derive from subtasks
}

/**
 * phase 282 Step A: derive contract status from subtasks（消除 CS-1/2/3/4 双源）。
 *
 * Derive rules（translated from cross-source-audit CS-1/2/3/4）:
 * - 所有 subtask completed（或有 completed_at / force_accepted）→ 'completed'
 * - 有 subtask in_progress → 'in_progress'
 * - 空 subtasks → 'pending'
 * - 否则 → 'pending'
 *
 * 注意：当前 lifecycle 下 contract 的终端状态由目录位置表达，不再写入 progress.status。
 */
/**
 * phase 344: derivable status subset type narrow (ML#9 优先编译器检查)。
 * phase 348: tuple-as-const + type derive (ML#1 共用基础设施单源、mirror phase 347 LIFECYCLE pattern)。
 *
 * Derivable status (phase 282 Step A design intent):
 * - 'pending'/'running'/'completed' 由 loader derive from subtasks、不持久化
 * - 终端状态（cancelled/corrupted/completed archive）由目录路径表达。
 * phase 358: DERIVABLE_STATUSES_TUPLE 物理迁 status-tuples.ts (解 schemas/types circular dep)
 * 自身 re-export 保 backward compat 既有 import path
 */
export { DERIVABLE_STATUSES_TUPLE } from './status-tuples.js';
import { DERIVABLE_STATUSES_TUPLE } from './status-tuples.js';

export type DerivableStatus = (typeof DERIVABLE_STATUSES_TUPLE)[number];

export function deriveProgressStatus(p: Pick<ProgressDataPersisted, 'subtasks'>): DerivableStatus {
  const subtasks = Object.values(p.subtasks);
  if (subtasks.length === 0) return 'pending';
  // 转译 CS-1/3/4：所有 subtask 语义上 completed（status='completed' 或有 completed_at / force_accepted）
  if (subtasks.every(s => s.status === 'completed' || s.completed_at !== undefined || s.force_accepted)) {
    return 'completed';
  }
  // 转译 CS-2 反向：不是所有 completed → running（存在 todo / in_progress）
  return 'running';
}

/**
 * phase 342: 共用基础设施单源 (ML#1)。
 * phase 344: typed ReadonlySet<DerivableStatus> (ML#9 typed set)。
 * phase 348: Set derive from tuple (ML#1 单源、3 literals 不再重复)。
 */
export const DERIVABLE_STATUSES: ReadonlySet<DerivableStatus> = new Set(DERIVABLE_STATUSES_TUPLE);

/**
 * phase 1127 Step B: archive state subdirectories (current terminal locations).
 */
export const ARCHIVE_STATE_DIRS_TUPLE = ['completed', 'cancelled', 'corrupted'] as const;

export type ArchiveState = (typeof ARCHIVE_STATE_DIRS_TUPLE)[number];

export const ARCHIVE_STATES: ReadonlySet<ArchiveState> = new Set(ARCHIVE_STATE_DIRS_TUPLE);

/**
 * Step B: current lifecycle is path-derived; ProgressData.status only carries the
 * aggregate of subtasks. ContractLifecycleState is the runtime location vocabulary.
 */
export type ProgressAggregateStatus = DerivableStatus;
export type ContractLifecycleState = 'active' | ArchiveState;

/**
 * phase 351 / 1123 Step C: ACTIVE_STATUSES tuple/type/Set 一以贯之 (mirror phase 347/348 pattern)。
 * 非终态契约的 status: pending + running (DerivableStatus 活动态)。
 * archive sweep 用、检测 archive 内仍含 ACTIVE status 的 stale entries。
 */
export const ACTIVE_STATUSES_TUPLE = [
  'pending',                      // DerivableStatus
  'running',                      // DerivableStatus
] as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES_TUPLE)[number];

export const ACTIVE_STATUSES: ReadonlySet<ActiveStatus> = new Set(ACTIVE_STATUSES_TUPLE);

/**
 * phase 342: strip derivable status field before persist。
 * 双 site 使用: persistence.ts saveProgress + manager.ts boot_reconcile。
 * 对称 deriveProgressStatus (derive on load) + stripDerivableStatus (strip on persist)。
 *
 * In-place mutation: caller 传入 cloned object (e.g., `{ ...progress }`) 直接传入即可、
 * 不再 inline `||` chain check + delete。
 *
 * phase 344: typed ReadonlySet<DerivableStatus> 需 cast string check (Set.has runtime 不窄 string)。
 */
export function stripDerivableStatus(p: Record<string, unknown>): void {
  if (typeof p.status === 'string' && (DERIVABLE_STATUSES as ReadonlySet<string>).has(p.status)) {
    delete p.status;
  }
}

/**
 * Step C: current progress disk protocol removes all derive fields (contract_id + status)
 * before persistence. Caller passes a shallow clone; in-place mutation is safe because
 * the clone is owned by the writer.
 */
export function stripProgressDerivedFields(p: Record<string, unknown>): void {
  delete p.contract_id;
  delete p.status;
}

export interface VerificationResult {
  passed: boolean;
  feedback: string;
  allCompleted?: boolean;  // 仅 passed=true 时有意义
  async?: boolean;         // true 时代表验收已提交后台，结果由 inbox 通知
  structured?: { passed: boolean; reason: string; issues?: string[] };  // LLM 验收的结构化结果
}

/**
 * Verifier scheduling config（移自 verifier-scheduler.ts / phase427 STALE 推翻 / inline）
 *
 * phase 19 Step A: split into VerifierIdentityConfig + VerifierRuntimeConfig (ISP).
 * VerifierConfig is the intersection — runtime shape unchanged, structurally compatible.
 */
export interface VerifierIdentityConfig {
  agentId: string;
  prompt: string;
  clawDir: string;
  clawId: ClawId;               // phase 514 / caller's clawId for subagent context
  /** phase 1080: contractId for crash-recovery status check / phase 1151: made required for audit emit contractId col */
  contractId: ContractId;
}

export interface VerifierRuntimeConfig {
  llm: LLMOrchestrator;
  fs: FileSystem;
  /** Audit writer / phase 646 ⚓ verifier cleanup audit / per `feedback_audit_injection_alpha_template` */
  audit: AuditLog;
  /** ContractSystem 装配期注入 / verifier subagent 内部用 getForProfile('readonly') 派生 read+ls+search 工具子集 / + reportTool 注册 / 与 system prompt 指令 align（M#7 / phase 704） */
  toolRegistry: ToolRegistry;
  idleTimeoutMs: number;
  // phase 1490: maxSteps optional / undefined propagate → SubAgent boundary fallback to DEFAULT_MAX_STEPS (agent-executor owner)
  maxSteps?: number;
  onIdleTimeout?: () => void;
  /** AbortSignal for cancel propagation / phase 993 D.1 / contract cancel 提前 abort verifier (vs idleTimeoutMs 等待) */
  signal?: AbortSignal;
  /** Tool-level wall-clock timeout inherited from globalConfig.tool_timeout_ms (phase 1029 / F-2) */
  toolTimeoutMs?: number;
  /** Factory for cross-claw FileSystem access (injected by ContractSystem) */
  fsFactory?: (baseDir: string) => FileSystem;
  /** phase 91: optional runSubagent injection for DI (replaces vi.mock pattern in tests) */
  runSubagent?: (opts: unknown) => Promise<{ text: string; capturedResult?: unknown }>;
}

export type VerifierConfig = VerifierIdentityConfig & VerifierRuntimeConfig;

export interface VerifierResult {
  passed: boolean;
  feedback: string;
  structured?: { passed: boolean; reason: string; issues?: string[] };
}

/** Phase 1335 (r138 F fork): cross-module query API — archive contract reference */
export interface ArchiveContractRef {
  clawId: ClawId;
  contractId: ContractId;
  contractDir: string;
  archivedAt?: string;
}

// ============================================================================
// phase 1366: SubtaskId branded type (compile-time ID discrimination)
// ============================================================================

declare const SubtaskIdBrand: unique symbol;
export type SubtaskId = string & { readonly [SubtaskIdBrand]: true };
export function makeSubtaskId(s: string): SubtaskId { return s as SubtaskId; }

// ============================================================================
// phase 1376: ArchiveDir branded path type (compile-time path discrimination)
// per M#3 资源唯一归属 / contract archive 业务专属 → contract types own
// ============================================================================

declare const ArchiveDirBrand: unique symbol;
export type ArchiveDir = string & { readonly [ArchiveDirBrand]: true };
export function makeArchiveDir(s: string): ArchiveDir { return s as ArchiveDir; }

// ============================================================================
// Phase 230: ContractCreatePolicy plug-in registry framework
// ============================================================================

export interface CreatePolicyContext {
  /** caller 调用上下文中的 subagent task id（CLI 命令可从 env.CHESTNUT_SUBAGENT_TASK_ID 拿、in-process 路径自定） */
  subagentTaskId?: string;
  /** 创建 contract 的 claw 目录、policy 可基于此做 claw-scoped 校验 */
  clawDir?: string;
}

export interface ContractCreatePolicy {
  /** policy 命名空间（caller 模块自负、如 'summon-verify'） */
  name: string;
  /** 通过 = void、拒 = throw ContractCreatePolicyViolationError */
  check(ctx: CreatePolicyContext, contract: ContractYaml): Promise<void>;
}

export class ContractCreatePolicyViolationError extends Error {
  constructor(
    public readonly policyName: string,
    public readonly cause: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(`contract create rejected by policy '${policyName}': ${cause}`);
    this.name = 'ContractCreatePolicyViolationError';
  }
}

// phase 406 Step C (review N10): saveProgress refuses to persist known-invalid
// progress shape — caller decides whether to abort or roll back.
export class ContractProgressInvariantViolatedError extends Error {
  constructor(
    message: string,
    public readonly details: { contractId: string; issuePath: string },
  ) {
    super(message);
    this.name = 'ContractProgressInvariantViolatedError';
  }
}

export interface CreateContractOptions {
  contract: ContractYaml;
  subagentTaskId?: string;
  clawDir?: string;
}

/**
 * phase 1121 Step C: deterministic persistent corruption reasons.
 * Only these reasons may write the corruption lifecycle transition.
 */
export type ContractCorruptionReason =
  | 'yaml_parse_error'
  | 'yaml_schema_invalid'
  | 'progress_json_parse_error'
  | 'progress_schema_invalid'
  | 'progress_unknown_schema_version';

/**
 * phase 1121 Step C: stable evidence reference relative to the Contract root.
 * The path remains valid after the Contract dir is moved into archive.
 */
export interface ContractCorruptionEvidence {
  reason: ContractCorruptionReason;
  relativePath: string;
}
