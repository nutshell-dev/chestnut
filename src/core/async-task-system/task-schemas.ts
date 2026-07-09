/**
 * @module L4.AsyncTaskSystem.Schemas
 * Zod schemas for SubAgentTask + ToolTask shape validation.
 *
 * Phase 1019 / r124 E fork: schema_version 写而不读 cluster (C-7) 之 (a) TaskMeta strict zod.
 * 替 phase 852 立 `validateTaskShape` 仅 2 字段 discriminator check / 校全字段 / boundary input 不再 trusted.
 * Phase 1185: SubAgentTask 改 discriminated union (mode: 'standard' | 'shadow') + backwards-compat preprocess.
 */

import { z } from 'zod';


// 字符串值与 system.ts CallerType 等价（保持单一真相 / type-import）
const CallerTypeSchema = z.enum(['claw', 'spawn_subagent', 'verifier', 'shadow_subagent', 'miner_subagent']);

/**
 * phase 281: SummonDecision 内嵌 metadata，与 async-task task 文件 lifecycle 同步。
 * 字段对齐 summon-state-store.ts SummonDecision（不含 taskId，task.id 即 taskId）。
 */
export const SummonDecisionMetadataSchema = z.object({
  schema_version: z.literal(1),
  mode: z.enum(['shadow', 'mining']),
  verify: z.boolean(),
  targetClaw: z.string().optional(),
  dispatchedAt: z.string(),
});

export type SummonDecisionMetadata = z.infer<typeof SummonDecisionMetadataSchema>;

const commonSubAgentFields = {
  kind: z.literal('subagent'),
  id: z.string(),
  timeoutMs: z.number(),
  // phase 1490: maxSteps optional / undefined → SubAgent boundary fallback to DEFAULT_MAX_STEPS
  maxSteps: z.number().optional(),
  parentClawId: z.string(),
  createdAt: z.string(),
  callerType: CallerTypeSchema.optional(),
  originClawId: z.string().optional(),
  motionClawDir: z.string().optional(),
  postProcessor: z.string().optional(),
  mainContextSnapshot: z.object({
    clawId: z.string(),
    toolUseId: z.string(),
  }).optional(),
  systemPrompt: z.string().optional(),
  // phase 1087 shadow async 上下文快照字段（phase 1131 补 zod schema、消除 type-schema drift per feedback_ts_interface_vs_zod_schema_sync）
  // Message[] / ToolDefinition[] 复杂 union types 跨 LLM provider、schema 层用 z.unknown() loose（type safety 归 TS interface SubAgentTask）
  isShadow: z.boolean().optional(),
  shadowSystemPrompt: z.string().optional(),
  shadowToolsForLLM: z.array(z.unknown()).optional(),
  // phase 218: intent 提到 common fields（union 合并）
  intent: z.string(),
  // phase 281: summon decision 内嵌 metadata，随 task lifecycle 同步
  summonDecision: SummonDecisionMetadataSchema.optional(),
};

const standardSubAgentTaskSchema = z.object({
  ...commonSubAgentFields,
  mode: z.literal('standard'),
  shadowMessages: z.array(z.unknown()).optional(),
});

const shadowSubAgentTaskSchema = z.object({
  ...commonSubAgentFields,
  mode: z.literal('shadow'),
  shadowMessages: z.array(z.unknown()),
});

const subAgentTaskDiscriminatedUnion = z.discriminatedUnion('mode', [
  standardSubAgentTaskSchema,
  shadowSubAgentTaskSchema,
]);

// phase 311 ML#9 strict: 删 preprocess hook（mode inject + old shadow intent field rename）。
// active load path pending/running 0 file 含 legacy schema、9 天 audit 0 emit
// 删 silent fallback。
export const SubAgentTaskSchema = subAgentTaskDiscriminatedUnion;

export const ToolTaskSchema = z.object({
  kind: z.literal('tool'),
  id: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()),
  parentClawDir: z.string(),
  parentClawId: z.string(),
  createdAt: z.string(),
  isIdempotent: z.boolean(),
  maxRetries: z.number(),
  retryCount: z.number(),
  // optional fields
  callerType: CallerTypeSchema.optional(),
  toolUseId: z.string().optional(),
  isShadow: z.boolean().optional(),
});

export const TaskSchema = z.union([
  SubAgentTaskSchema,
  ToolTaskSchema,
]);
