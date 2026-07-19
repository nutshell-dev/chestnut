/**
 * @module L4.ContractSystem.Schemas
 * Zod schemas for ContractYaml + ContractProgressPersisted shape validation (phase 311 + phase 319 ML#9 strict + 编码规范契约先行).
 *
 * Phase 311 立 ContractYamlSchema (mirror task-schemas.ts + phase 305 file-tool pattern)。
 * Phase 319 broaden: ContractProgressPersistedSchema + Zod SoT for progress.json (mirror
 *   phase 311 ContractYamlSchema pattern、phase 311 升档条件 (A) sister)。
 *
 * 共享 pattern: schema_version: z.literal(1) brand + .strict() reject unknown field + type derive from schema。
 *
 * Phase 311 替换 phase 1019 / r124 E fork hand-rolled schema_version invariant check + phase
 *   1257/1399 旧字段 silent fallback parse code (active load path 9 天 audit 0 emit + 0
 *   production active load path file by phase 311 evidence-based verify)。
 * Phase 319 替换 phase 1134 hand-rolled schema_version invariant check + invariants.ts
 *   assertProgressShapeInvariants (production 0 active progress.json + 0 audit emit
 *   contract_progress_invariant_violated 9 天 verify)。
 */

import { z } from 'zod';

// Step B: explicit legacy progress status vocabulary (historical flat archive input only).
// Current writer / loader / runtime types must not treat these as current domain vocabulary.
export const LEGACY_PROGRESS_STATUSES_TUPLE = [
  'pending',
  'running',
  'completed',
  'cancelled',
  'paused',
  'crashed',
  'archive_pending_recovery',
  'archive_corrupted',
] as const;

const SubTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
}).strict();

// phase 366 L4 (review-2026-06-13): script_file / prompt_file 改 required per type。
// 旧 schema 两者都 optional、与 manager.ts:669-677 runtime check 不一致 — schema 通过
// 但 verifier 真跑时 throw `verification config ... missing 'script_file'`。
// 现在 schema parse 即拒、错误指向具体 verification entry。
const VerificationItemSchema = z.discriminatedUnion('type', [
  z.object({ subtask_id: z.string(), type: z.literal('script'), script_file: z.string() }).strict(),
  z.object({ subtask_id: z.string(), type: z.literal('llm'), prompt_file: z.string() }).strict(),
]);

export const ContractYamlSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().optional(),
  title: z.string(),
  background: z.string().optional(),
  goal: z.string(),
  expectations: z.string().optional(),
  subtasks: z.array(SubTaskSchema),
  verification: z.array(VerificationItemSchema).optional(),
  auth_level: z.enum(['auto', 'notify', 'confirm']).optional(),
  verification_attempts: z.number().optional(),
  audit_interval: z.number().optional(),
}).strict();

export type ContractYamlValidated = z.infer<typeof ContractYamlSchema>;

// phase 319 broaden Zod SoT pattern for progress.json (mirror ContractYamlSchema)

const LastFailedFeedbackSchema = z.object({
  feedback: z.string(),
  cause: z.enum(['llm_rejected', 'programming_bug', 'subagent_timeout', 'script_failed']),
}).strict();

// phase 362: SUBTASK_STATUSES_TUPLE 复用 (ML#1 单源 from status-tuples.ts)
// Phase 1134: new-layout runtime/attempt tuples
import {
  SUBTASK_STATUSES_TUPLE,
  SUBTASK_RUNTIME_STATUSES_TUPLE,
  VERIFICATION_ATTEMPT_STATUSES_TUPLE,
} from './status-tuples.js';

const SubtaskProgressSchema = z.object({
  // phase 362: tuple derive (mirror phase 347 LIFECYCLE pattern)
  status: z.enum(SUBTASK_STATUSES_TUPLE),
  completed_at: z.string().optional(),
  evidence: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  retry_count: z.number().optional(),
  last_failed_feedback: LastFailedFeedbackSchema.optional(),
  force_accepted: z.boolean().optional(),
  // Phase 961: unique per verification attempt, prevents ABA (late result from a previous attempt applied to current one)
  // Phase 967: required when subtask is in_progress; optional otherwise.
  verification_attempt_id: z.string().optional(),
}).strict().refine(
  (data) => !(data.status === 'in_progress' && data.verification_attempt_id === undefined),
  {
    message: 'verification_attempt_id is required when subtask status is in_progress',
    path: ['verification_attempt_id'],
  },
);

export const ContractProgressPersistedSchema = z.object({
  schema_version: z.literal(1),
  subtasks: z.record(z.string(), SubtaskProgressSchema),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  checkpoint: z.union([z.string(), z.null()]).optional(),
  // Step C: current progress.json no longer carries lifecycle status. Status is derived from
  // subtasks at load time; lifecycle state is committed by the directory path.
}).strict();

export type ContractProgressPersistedValidated = z.infer<typeof ContractProgressPersistedSchema>;

// Phase 1134: new active/current layout schemas (strict, fail-closed)

/**
 * Persisted contract.yaml in the new layout: id is required after creation.
 * The create-input schema (ContractYamlSchema) continues to allow optional id.
 */
export const PersistedContractYamlSchema = ContractYamlSchema.extend({
  id: z.string().min(1),
}).strict();

export const VerificationAttemptRecordSchema = z.object({
  id: z.string().min(1),
  status: z.enum(VERIFICATION_ATTEMPT_STATUSES_TUPLE),
  started_at: z.string().min(1),
  finished_at: z.string().min(1).optional(),
  evidence: z.string(),
  artifacts: z.array(z.string()),
  feedback: z.string().optional(),
  cause: z.enum([
    'llm_rejected',
    'programming_bug',
    'subagent_timeout',
    'script_failed',
    'daemon_restart',
  ]).optional(),
}).strict().superRefine((attempt, ctx) => {
  if (attempt.status !== 'running' && attempt.finished_at === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['finished_at'],
      message: 'terminal attempt requires finished_at',
    });
  }
  if (attempt.status === 'running' && attempt.finished_at !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['finished_at'],
      message: 'running attempt forbids finished_at',
    });
  }
});

export const SubtaskRuntimeRecordSchema = z.object({
  schema_version: z.literal(1),
  subtask_id: z.string().min(1),
  status: z.enum(SUBTASK_RUNTIME_STATUSES_TUPLE),
  current_attempt_id: z.string().min(1).optional(),
  attempts: z.array(VerificationAttemptRecordSchema),
  completed_at: z.string().min(1).optional(),
  evidence: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  force_accepted: z.boolean().optional(),
}).strict().superRefine((record, ctx) => {
  const ids = record.attempts.map(a => a.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['attempts'],
      message: 'attempt ids must be unique',
    });
  }
  const running = record.attempts.filter(a => a.status === 'running');
  if (record.status === 'verifying') {
    if (running.length !== 1 || running[0]?.id !== record.current_attempt_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['current_attempt_id'],
        message: 'verifying must reference exactly one running attempt',
      });
    }
  } else if (record.current_attempt_id !== undefined || running.length !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['current_attempt_id'],
      message: 'non-verifying record cannot have a running attempt',
    });
  }
  if (record.status === 'completed' && record.completed_at === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['completed_at'],
      message: 'completed record requires completed_at',
    });
  }
  if (record.status !== 'completed' && record.completed_at !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['completed_at'],
      message: 'non-completed record forbids completed_at',
    });
  }
  if (record.force_accepted === true && record.status !== 'completed') {
    ctx.addIssue({
      code: 'custom',
      path: ['force_accepted'],
      message: 'force_accepted only allowed for completed',
    });
  }
});

// phase 332: archive reader loose schema for historical preservation
// M#2 archive 业务语义 = historical preservation (218/274 archive file legacy schema_version-missing + 多 legacy 字段 shape)、
// minimal validation = subtasks is record(object)、其余字段 passthrough (archive event-collector 只 read 真需字段)
// 不同于 PersistedSchema (active path strict-end)、use case strictness 一以贯之 Path #6
// passthrough subtasks 内部 (legacy may lack last_failed_feedback.cause、status enum 等 strict 约束)
const ArchiveSubtaskShape = z.object({
  status: z.string().optional(),
  completed_at: z.string().optional(),
  evidence: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  retry_count: z.number().optional(),
  last_failed_feedback: z.object({
    feedback: z.string().optional(),
    cause: z.string().optional(),
  }).passthrough().optional(),
  force_accepted: z.boolean().optional(),
}).passthrough();

export const ContractProgressArchiveLooseSchema = z.object({
  schema_version: z.literal(1).optional(),
  subtasks: z.record(z.string(), ArchiveSubtaskShape),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  checkpoint: z.union([z.string(), z.null()]).optional(),
  // Step B: archive loose schema uses the explicit legacy vocabulary only.
  status: z.enum(LEGACY_PROGRESS_STATUSES_TUPLE).optional(),
  // phase 335: contract_id 在 archive/boot_reconcile 路径 legacy 可含 (derive 字段)、explicit typed access
  contract_id: z.string().optional(),
}).passthrough();

export type ContractProgressArchiveValidated = z.infer<typeof ContractProgressArchiveLooseSchema>;
