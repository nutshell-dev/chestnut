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

const SubTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
}).strict();

const VerificationItemSchema = z.discriminatedUnion('type', [
  z.object({ subtask_id: z.string(), type: z.literal('script'), script_file: z.string().optional() }).strict(),
  z.object({ subtask_id: z.string(), type: z.literal('llm'), prompt_file: z.string().optional() }).strict(),
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

const SubtaskProgressSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'completed']),
  completed_at: z.string().optional(),
  evidence: z.string().optional(),
  artifacts: z.array(z.string()).optional(),
  retry_count: z.number().optional(),
  last_failed_feedback: LastFailedFeedbackSchema.optional(),
  force_accepted: z.boolean().optional(),
}).strict();

export const ContractProgressPersistedSchema = z.object({
  schema_version: z.literal(1),
  subtasks: z.record(z.string(), SubtaskProgressSchema),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  checkpoint: z.union([z.string(), z.null()]).optional(),
  // phase 330: non-derivable lifecycle status preserved by persistence.ts (per phase 282 Step A design intent)
  // derivable status (completed/running/pending) 不持久化 (由 loader derive from subtasks)
  status: z.enum(['cancelled', 'crashed', 'paused', 'archive_pending_recovery']).optional(),
}).strict();

export type ContractProgressPersistedValidated = z.infer<typeof ContractProgressPersistedSchema>;

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
  status: z.string().optional(),
  // phase 335: contract_id 在 archive/boot_reconcile 路径 legacy 可含 (derive 字段)、explicit typed access
  contract_id: z.string().optional(),
}).passthrough();

export type ContractProgressArchiveValidated = z.infer<typeof ContractProgressArchiveLooseSchema>;
