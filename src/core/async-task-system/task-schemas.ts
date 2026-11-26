/**
 * @module L4.AsyncTaskSystem.Schemas
 * Zod schemas for SubAgentTask + ToolTask shape validation.
 *
 * Phase 1019 / r124 E fork: schema_version 写而不读 cluster (C-7) 之 (a) TaskMeta strict zod.
 * 替 phase 852 立 `validateTaskShape` 仅 2 字段 discriminator check / 校全字段 / boundary input 不再 trusted.
 * phase 1863 (AT-D7): SubAgentTask 去 discriminated union——mode opaque 可选 + opaque executorPayload。
 */

import { z } from 'zod';


// phase 1863 (AT-D8)：opaque correlation（ATS 不预设 caller universe；source 为 caller 自声明字符串）
const TaskCorrelationSchema = z.object({
  source: z.string(),
  ref: z.string().optional(),
});

/** JSON-only nested payload guard; no schema stripping or lossy JSON.stringify coercion. */
export function isExecutionInputJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isExecutionInputJsonValue(item, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && Object.values(value).every(item => isExecutionInputJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

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
  correlation: TaskCorrelationSchema.optional(),
  toolProfile: z.string().optional(),
  originClawId: z.string().optional(),
  // phase 1863 (AT-D6): 删 legacy motionClawDir（无 active writer；存量任务读取经 zod strip
  // 兼容——多余键忽略不拒绝，见 legacy-migration.test.ts 专测）
  postProcessor: z.string().optional(),
  systemPrompt: z.string().optional(),
  // phase 1863 (AT-D7)：执行 owner 的 opaque payload（JSON 可序列化；ATS 不枚举/解释语义）
  executorPayload: z.unknown().optional(),
  // Phase 2248 F：只校验版本化外壳；内部 PreparedSubagentInput 归执行 owner 校验。
  executionInput: z.object({
    schema_version: z.literal(1),
    input: z.unknown().refine(isExecutionInputJsonValue, { message: 'executionInput.input must be JSON' }),
  }).strict().refine(value => Object.hasOwn(value, 'input'), { message: 'executionInput.input is required' }).optional(),
  intent: z.string(),
  // Phase 1402 Step B: legacy v1/v2 Summon recovery input（read-only）；active writers 不得写入
  summonDecision: SummonDecisionMetadataSchema.optional(),
  // Phase 874: persisted terminal intent for recovery routing
  terminalState: z.enum(['done', 'failed']).optional(),
};

// phase 1863 (AT-D7): 去 standard/shadow discriminated union——mode 降为 opaque 可选字符串
// （ATS 不枚举上层模式；legacy 'standard'/'shadow' 值读取容忍），执行语义经 executorPayload
// + 专用旧 payload 的迁移解释归对应业务 owner。
const subAgentTaskSchema = z.object({
  ...commonSubAgentFields,
  mode: z.string().optional(),
});

export const SubAgentTaskSchema = subAgentTaskSchema;

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
  // phase 1863 (AT-D7): 删 dead ToolTask.isShadow（无 writer/无 reader；旧任务读取经 zod strip 兼容）
  // phase 844: sync with ToolTask TS interface — migrated exec fields
  mode: z.enum(['fresh', 'migrated']).optional(),
  migratedPid: z.number().optional(),
  migratedStartTime: z.string().optional(),
  // Opaque ProcessExec persistence. Version/shape/PGID validation and legacy
  // decoding stay in L1 so invalid or future identities remain recoverable
  // artifacts instead of being interpreted by ATS.
  migratedExecution: z.unknown().optional(),
  // Phase 906: absolute deadline (ms) for migrated process hard timeout
  migratedDeadlineMs: z.number().optional(),
  // Phase 874: confirmed terminal state for recovery routing
  terminalState: z.enum(['done', 'failed']).optional(),
  // Phase 2150: decoded by migrated-exec-result; malformed/future intent must
  // keep the running artifact recoverable instead of corrupting the whole task.
  migratedExecTerminalIntent: z.unknown().optional(),
});

export const TaskSchema = z.union([
  SubAgentTaskSchema,
  ToolTaskSchema,
]);
