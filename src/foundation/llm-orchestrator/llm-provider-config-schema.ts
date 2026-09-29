/**
 * LLMProvider config schema / phase 10 decentralize Config 拆解
 * Owner: llm-orchestrator（每 LLM provider 的 yaml schema 业主）
 * Source: 迁自 foundation/config/schemas.ts:41-59 createLLMProviderSchema
 */
import { z } from 'zod';
import {
  DEFAULT_LLM_TIMEOUT_MS,
} from './defaults.js';

export const FORMAT_MAP: Record<string, string> = {
  '1': 'custom-anthropic',
  '2': 'custom-openai',
  '3': 'custom-gemini',
};

export const llmProviderConfigSchema = z.object({
  preset: z.string().min(1).optional(),
  label: z.string().optional(),
  // Phase 1926 Step D：api_key 可选——ambient（AWS 链/ADC/provider env）与 OAuth
  // preset 不在 yaml 持 key；api_key preset 的必填约束由 CLI 交互/缺参判定保证。
  api_key: z.string().min(1, 'api_key must not be empty').optional(),
  base_url: z.string().optional(),
  model: z.string().optional(),
  max_tokens: z.number().min(1).optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  timeout_ms: z.number().min(1000).max(600000).default(DEFAULT_LLM_TIMEOUT_MS),
  thinking: z.boolean().optional(),
  thinking_budget_tokens: z.number().min(1).optional(),
  thinking_mode: z.enum(['adaptive', 'enabled']).optional(),
  thinking_effort: z.enum(['low', 'medium', 'high']).optional(),
  extra_headers: z.record(z.string()).optional(),
  drop_thinking_blocks: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
  // Phase 1925 Step D: transport 字段已删除（pi-ai 唯一路径）；zod 默认 strip 未知键，
  // 既有 yaml 中的 transport 键静默忽略、配置可读（回滚兼容）
});

export type LLMProviderConfig = z.infer<typeof llmProviderConfigSchema>;
