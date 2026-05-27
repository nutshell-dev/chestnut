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
const CallerTypeSchema = z.enum(['claw', 'subagent', 'verifier', 'shadow', 'miner']);

const commonSubAgentFields = {
  kind: z.literal('subagent'),
  id: z.string(),
  timeoutMs: z.number(),
  maxSteps: z.number(),
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
};

const standardSubAgentTaskSchema = z.object({
  ...commonSubAgentFields,
  mode: z.literal('standard'),
  intent: z.string(),
  shadowMessages: z.array(z.unknown()).optional(),
});

const shadowSubAgentTaskSchema = z.object({
  ...commonSubAgentFields,
  mode: z.literal('shadow'),
  shadowMessages: z.array(z.unknown()),
  intentPreview: z.string().max(60),
});

const subAgentTaskDiscriminatedUnion = z.discriminatedUnion('mode', [
  standardSubAgentTaskSchema,
  shadowSubAgentTaskSchema,
]);

/**
 * Backwards-compat: old pendingTask files may lack `mode` field.
 * Preprocess injects `mode: 'standard'` for legacy files.
 *
 * SUNSET per phase 1258: 30 天 audit LEGACY_PENDING_TASK_NO_MODE 0 触发
 * → r+ phase 删 preprocess hook + cascade reader (sunset-monitor cron job 周期 query)
 * Original TODO(phase 1186+) 过期 64 phase / replaced by sunset trigger metadata.
 */
export const SubAgentTaskSchema = z.preprocess(
  (val) => {
    if (typeof val === 'object' && val !== null && !('mode' in val)) {
      return { ...(val as object), mode: 'standard' };
    }
    return val;
  },
  subAgentTaskDiscriminatedUnion,
);

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
