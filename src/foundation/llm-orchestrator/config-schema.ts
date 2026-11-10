/**
 * LLMOrchestrator config schema / phase 10 decentralize Config 拆解
 * Owner: llm-orchestrator（容错编排 + circuit breaker yaml schema 业主）
 * Composed by: src/assembly/compose-config.ts (yaml `llm.*` field)
 */
import { z } from 'zod';
import {
  DEFAULT_LLM_RETRY_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RESET_TIMEOUT_MS,
} from './defaults.js';
import { llmProviderConfigSchema } from '../llm-provider/index.js';

const circuitBreakerConfigSchema = z.object({
  failure_threshold: z.number().min(1).max(20).default(3),
  reset_timeout_ms: z.number().min(1000).max(3600000).default(DEFAULT_RESET_TIMEOUT_MS),
});

export const llmOrchestratorConfigSchema = z.object({
  primary: llmProviderConfigSchema,
  fallbacks: z.array(llmProviderConfigSchema).optional(),
  retry_attempts: z.number().min(0).max(10).default(DEFAULT_LLM_RETRY_ATTEMPTS),
  retry_delay_ms: z.number().min(0).max(60000).default(DEFAULT_RETRY_DELAY_MS),
  // 兼容接收旧 breaker 段；缺段不物化，显式空 object 仍保留子字段默认值供诊断。
  circuit_breaker: circuitBreakerConfigSchema.optional(),
});
