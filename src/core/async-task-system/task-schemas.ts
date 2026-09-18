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
const CallerTypeSchema = z.enum(['spawn_subagent', 'verifier', 'shadow_subagent', 'miner_subagent']);

/**
 * Phase 1396 Step K: SummonDecision 版本化 metadata。
 * Phase 1402 Step B: 降级 legacy read-only —— active writer 已停写本字段，
 * 当前 summon task 由 canonical post-processor identity 识别；以下 schema/type
 * 仅为已落盘 v1/v2 task 的中断恢复读取保留，物理删除另立 phase。
 *
 * - v2 (legacy): 只标识“这是 summon contract creation”及派发时间；固定 no-verification
 *   策略由 SummonSystem policy 直接拥有，不再伪装成 caller choice。
 * - v1 (legacy): 保留已落盘任务的严格读取字段（mode/verify/可选 targetClaw）。
 */
export const LegacySummonDecisionV1Schema = z.object({
  schema_version: z.literal(1),
  mode: z.enum(['shadow', 'mining']),
  verify: z.boolean(),
  targetClaw: z.string().optional(),
  dispatchedAt: z.string(),
});

export const SummonDecisionV2Schema = z.object({
  schema_version: z.literal(2),
  dispatchedAt: z.string(),
}).strict();

export const SummonDecisionMetadataSchema = z.discriminatedUnion('schema_version', [
  LegacySummonDecisionV1Schema,
  SummonDecisionV2Schema,
]);

export type SummonDecisionMetadata = z.infer<typeof SummonDecisionMetadataSchema>;
export type LegacySummonDecisionV1 = z.infer<typeof LegacySummonDecisionV1Schema>;
export type SummonDecisionV2 = z.infer<typeof SummonDecisionV2Schema>;

const commonSubAgentFields = {
  kind: z.literal('subagent'),
  // Phase 868: full persistence ID must be a valid UUID
  id: z.string().uuid(),
  // Phase 867/868: explicit 8-char hex display ID
  shortId: z.string().regex(/^[0-9a-f]{8}$/),
  timeoutMs: z.number(),
  // phase 1490: maxSteps optional / undefined → SubAgent boundary fallback to DEFAULT_MAX_STEPS
  maxSteps: z.number().optional(),
  parentClawId: z.string(),
  createdAt: z.string(),
  callerType: CallerTypeSchema.optional(),
  toolProfile: z.string().optional(),
  originClawId: z.string().optional(),
  // phase 1863 (AT-D6): 删 legacy motionClawDir（无 active writer；存量任务读取经 zod strip
  // 兼容——多余键忽略不拒绝，见 legacy-migration.test.ts 专测）
  postProcessor: z.string().optional(),
  systemPrompt: z.string().optional(),
  // phase 1087 shadow async 上下文快照字段（phase 1131 补 zod schema、消除 type-schema drift per feedback_ts_interface_vs_zod_schema_sync）
  // Message[] / ToolDefinition[] 复杂 union types 跨 LLM provider、schema 层用 z.unknown() loose（type safety 归 TS interface SubAgentTask）
  isShadow: z.boolean().optional(),
  shadowSystemPrompt: z.string().optional(),
  shadowToolsForLLM: z.array(z.unknown()).optional(),
  // phase 218: intent 提到 common fields（union 合并）
  intent: z.string(),
  // Phase 1402 Step B: legacy v1/v2 Summon recovery input（read-only）；active writers 不得写入
  summonDecision: SummonDecisionMetadataSchema.optional(),
  // Phase 874: persisted terminal intent for recovery routing
  terminalState: z.enum(['done', 'failed']).optional(),
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
  // Phase 868: full persistence ID must be a valid UUID
  id: z.string().uuid(),
  // Phase 867/868: explicit 8-char hex display ID
  shortId: z.string().regex(/^[0-9a-f]{8}$/),
  toolName: z.string(),
  args: z.record(z.unknown()),
  parentClawDir: z.string(),
  parentClawId: z.string(),
  createdAt: z.string(),
  isIdempotent: z.boolean(),
  maxRetries: z.number(),
  retryCount: z.number(),
  // optional fields
  toolUseId: z.string().optional(),
  isShadow: z.boolean().optional(),
  // phase 844: sync with ToolTask TS interface — migrated exec fields
  mode: z.enum(['fresh', 'migrated']).optional(),
  migratedPid: z.number().optional(),
  migratedStartTime: z.string().optional(),
  // Phase 1269: versioned execution-group identity (new migrated writes).
  // Unknown/future versions fail parsing — fail-observable, never guessed.
  // Step F: enforce the v1 creation invariant on disk — safe integers, > 1,
  // and PGID === leader PID (detached spawn makes the leader its own group).
  migratedExecution: z.object({
    version: z.literal(1),
    leaderPid: z.number().int().safe().gt(1),
    processGroupId: z.number().int().safe().gt(1),
    leaderStartTime: z.string().optional(),
  }).refine(
    (e) => e.processGroupId === e.leaderPid,
    { message: 'v1 execution identity requires processGroupId === leaderPid (detached group leader)' },
  ).optional(),
  // Phase 906: absolute deadline (ms) for migrated process hard timeout
  migratedDeadlineMs: z.number().optional(),
  // Phase 874: persisted terminal intent for recovery routing
  terminalState: z.enum(['done', 'failed']).optional(),
}).refine(
  // New migrated tasks must carry a complete execution identity; legacy
  // PID-only files stay loadable until they drain naturally.
  (t) => t.mode !== 'migrated' || t.migratedExecution !== undefined || t.migratedPid !== undefined,
  { message: 'migrated tool task requires migratedExecution (v1) or legacy migratedPid' },
);

export const TaskSchema = z.union([
  SubAgentTaskSchema,
  ToolTaskSchema,
]);
