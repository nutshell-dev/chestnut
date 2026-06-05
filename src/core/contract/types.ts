/**
 * @module L4.ContractSystem.Types
 * ContractSystem 内部 types 集中
 */

import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { FileSystem } from '../../foundation/fs/types.js';

// phase 64: ContractId brand 迁回（自 foundation/identity 解散）— 注释 admit
// 「物理迁自 core/contract/types.ts」(phase 1378)
// per ML#3 资源唯一归属（按业务真实归属）+ M#1 contract lifecycle 独立可变
declare const ContractIdBrand: unique symbol;
export type ContractId = string & { readonly [ContractIdBrand]: true };
export function makeContractId(s: string): ContractId { return s as ContractId; }
import type { AuditLog } from '../../foundation/audit/index.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import type { Priority } from '../../foundation/messaging/types.js';
import type { ClawId, ChestnutRoot } from '../../foundation/identity/index.js';
import { type ClawDir } from '../../foundation/identity/index.js';



// ============================================================================
// Contract domain types (canonical owner per interfaces/l4.md)
// ============================================================================

export type ContractStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'crashed'                                  // phase 63: agent loop 推不动契约的终态
  | 'archive_pending_recovery';  // phase 1371 sub-2: archiveAndEmit partial recovery state

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

// YAML contract file structure (exported for CLI use)
export interface ContractYaml {
  schema_version?: number;
  id?: string;
  title: string;
  background?: string;      // 用户意图
  goal: string;
  expectations?: string;    // 全局执行要求和质量期望
  subtasks: Array<{
    id: string;
    description: string;
  }>;
  verification?: Array<
    | { subtask_id: string; type: 'script'; script_file?: string }
    | { subtask_id: string; type: 'llm'; prompt_file?: string }
  >;
  auth_level?: 'auto' | 'notify' | 'confirm';
  verification_attempts?: number;  // 全局 retry 上限，默认 3
  // escalation 字段已废弃（phase 1399），读时通过 persistence.ts 自动迁移到 verification_attempts
  audit_interval?: number;  // phase 1424: contract auditor 周期、step 为单位、0 = disable（默 0）
}

// Progress data structure
export interface ProgressData {
  schema_version?: number;  // NEW phase 1134 / v1 = current
  contract_id: ContractId;
  status: ContractStatus;
  subtasks: Record<string, {
    status: SubtaskStatus;
    completed_at?: string;
    evidence?: string;
    artifacts?: string[];
    retry_count?: number;           // 默认 0，每次验收失败 +1
    last_failed_feedback?: LastFailedFeedback;
    force_accepted?: boolean;        // phase 1399: retry 试光后强接受标记
  }>;
  started_at?: string;
  checkpoint?: string | null;
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
  clawDir: ClawDir;
  /** phase 1387: Assembly 装配期注入的 chestnut 根目录 */
  chestnutRoot: ChestnutRoot;
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
// per ML#3 资源唯一归属 / contract archive 业务专属 → contract types own
// ============================================================================

declare const ArchiveDirBrand: unique symbol;
export type ArchiveDir = string & { readonly [ArchiveDirBrand]: true };
export function makeArchiveDir(s: string): ArchiveDir { return s as ArchiveDir; }
