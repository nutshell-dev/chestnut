/**
 * Per-claw config schema / phase 10 decentralize
 * Owner: runtime（claw daemon 个体 yaml schema 业主、claw 是 runtime instance）
 * Composed by: src/assembly/compose-config.ts (per-claw yaml)
 */
import { z } from 'zod';
import { llmProviderConfigSchema } from '../../foundation/llm-orchestrator/index.js';

export const clawConfigSchema = z.object({
  name: z.string(),
  llm: z.object({
    primary: llmProviderConfigSchema.optional(),
  }).optional(),
  max_steps: z.number().min(1).max(1000).optional(),
  tool_profile: z.enum(['full', 'readonly', 'subagent']).default('full'),
  subagent_max_steps: z.number().min(1).max(200).optional(),
  max_concurrent_tasks: z.number().min(1).max(20).default(3),
});

export type ClawConfig = z.infer<typeof clawConfigSchema>;
