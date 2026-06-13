/**
 * @module L4.ContractSystem.Types
 * ContractSystem 内部 types 集中
 */

import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

// phase 64: ContractId brand 迁回（自 foundation/identity 解散）— 注释 admit
// 「物理迁自 core/contract/types.ts」(phase 1378)
// per M#3 资源唯一归属（按业务真实归属）+ M#1 contract lifecycle 独立可变
declare const ContractIdBrand: unique symbol;
export type ContractId = string & { readonly [ContractIdBrand]: true };
export function makeContractId(s: string): ContractId { return s as ContractId; }
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { Priority } from '../../foundation/messaging/types.js';
import type { ClawId } from '../../constants.js';




// ============================================================================
// Contract domain types (canonical owner per interfaces/l4.md)
// ============================================================================

// phase 345: ContractStatus disjoint union recompose
// derive subset (DerivableStatus) 见 deriveProgressStatus return type、由 loader derive from subtasks
// persist subset (LifecyclePersistedStatus) 持久化保留、显式生命周期状态机
// phase 358: status tuples 物理放 status-tuples.ts (解 schemas/types circular dep)、type derive 仍归 types.ts
import { LIFECYCLE_PERSISTED_STATUSES_TUPLE } from './status-tuples.js';

export type LifecyclePersistedStatus = (typeof LIFECYCLE_PERSISTED_STATUSES_TUPLE)[number];

// 'pending' / 'running' / 'completed' = DerivableStatus (derive subset)
// 'paused' / 'cancelled' / 'crashed' / 'archive_pending_recovery' = LifecyclePersistedStatus (persist subset)
export type ContractStatus = DerivableStatus | LifecyclePersistedStatus;

export type SubtaskStatus =
  | 'todo'
  | 'in_progress'
  | 'completed';

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
  status: ContractStatus;
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
import type { ContractYamlValidated, ContractProgressPersistedValidated } from './schemas.js';
export type ContractYaml = ContractYamlValidated;

// phase 282 Step B: 落盘 schema（不含 derive field）
// phase 319: type derive from Zod schema (ML#9 优先编译器检查、broaden phase 311 pattern)
export type ProgressDataPersisted = ContractProgressPersistedValidated;

// Progress data structure（运行时 schema：derive fields 由 loader 注入）
// phase 282: status/contract_id 是 derive 字段，落盘不写；内存对象仍保留字段以兼容现有代码。
// phase 330: Omit<..., 'status'> 因 ProgressDataPersisted.status 是 non-derivable subset、
// ProgressData.status 是全 ContractStatus enum (含 derivable + non-derivable)
export interface ProgressData extends Omit<ProgressDataPersisted, 'status'> {
  contract_id: ContractId;   // phase 282 Step B: derive from caller/dir
  status: ContractStatus;    // phase 282 Step A: derive from subtasks
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
 * 注意：'running' / 'paused' / 'cancelled' / 'crashed' / 'archive_pending_recovery'
 * 等生命周期状态无法从 subtasks 单独 derive，仍由业务代码显式控制。
 */
/**
 * phase 344: derivable status subset type narrow (ML#9 优先编译器检查)。
 * phase 348: tuple-as-const + type derive (ML#1 共用基础设施单源、mirror phase 347 LIFECYCLE pattern)。
 *
 * Derivable status (phase 282 Step A design intent):
 * - 'pending'/'running'/'completed' 由 loader derive from subtasks、不持久化
 * - 'paused'/'cancelled'/'crashed'/'archive_pending_recovery' 不可 derive、持久化保留
 *
 * 与 ContractStatus (wide enum) 对称、derivable subset typed narrow。
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
 * phase 351: ARCHIVE_ALLOWED_STATUSES tuple/type/Set 一以贯之 (mirror phase 347/348 pattern)。
 * 终态契约可 archive 的 4 status: completed (derivable terminal) + 3 LifecyclePersistedStatus terminals。
 */
export const ARCHIVE_ALLOWED_STATUSES_TUPLE = [
  'completed',                    // DerivableStatus 终态
  'cancelled',                    // LifecyclePersistedStatus
  'crashed',                      // LifecyclePersistedStatus
  'archive_pending_recovery',     // LifecyclePersistedStatus
] as const;

export type ArchiveAllowedStatus = (typeof ARCHIVE_ALLOWED_STATUSES_TUPLE)[number];

export const ARCHIVE_ALLOWED_STATUSES: ReadonlySet<ArchiveAllowedStatus> = new Set(ARCHIVE_ALLOWED_STATUSES_TUPLE);

/**
 * phase 351: ACTIVE_STATUSES tuple/type/Set 一以贯之 (mirror phase 347/348 pattern)。
 * 非终态契约的 3 status: pending + running (DerivableStatus 活动态) + paused (LifecyclePersistedStatus 暂停)。
 * archive sweep 用、检测 archive 内仍含 ACTIVE status 的 stale entries。
 */
export const ACTIVE_STATUSES_TUPLE = [
  'pending',                      // DerivableStatus
  'running',                      // DerivableStatus
  'paused',                       // LifecyclePersistedStatus
] as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES_TUPLE)[number];

export const ACTIVE_STATUSES: ReadonlySet<ActiveStatus> = new Set(ACTIVE_STATUSES_TUPLE);

/**
 * phase 352: ALL_CONTRACT_STATUSES_TUPLE 合 2 base tuples (DERIVABLE + LIFECYCLE)、
 * cluster N=13 完整 status 体系单源 (ML#1 + ML#9 一以贯之)。
 *
 * ContractStatus = (typeof ALL_CONTRACT_STATUSES_TUPLE)[number] 等价 DerivableStatus | LifecyclePersistedStatus
 * (现 type 仍保 union 形态、便 deriveProgressStatus return narrow type 互兼容)。
 *
 * ALL_CONTRACT_STATUSES Set 提供 runtime check 基础设施 (e.g., 测试 exhaustive enumeration、status validation)。
 */
// phase 358: ALL_CONTRACT_STATUSES_TUPLE 物理迁 status-tuples.ts、re-export 保 backward compat
export { ALL_CONTRACT_STATUSES_TUPLE } from './status-tuples.js';
import { ALL_CONTRACT_STATUSES_TUPLE } from './status-tuples.js';

export const ALL_CONTRACT_STATUSES: ReadonlySet<ContractStatus> = new Set(ALL_CONTRACT_STATUSES_TUPLE);

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

export interface CreateContractOptions {
  contract: ContractYaml;
  subagentTaskId?: string;
  clawDir?: string;
}
