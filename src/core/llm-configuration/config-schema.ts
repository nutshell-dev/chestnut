/**
 * Persisted LLM configuration document schema. Runtime orchestrator options are
 * assembled separately from ProviderInput and ProviderFactory.
 * Owner: L4 llm-configuration.
 */
import { z } from 'zod';
import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js';
const { llmProviderConfigSchema, strictLLMProviderConfigSchema } = llmProviderConfigContract;

// L4 owns persisted configuration defaults; values remain compatible with L2.
const DEFAULT_LLM_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_RESET_TIMEOUT_MS = 60000;

const circuitBreakerConfigSchema = z.object({
  failure_threshold: z.number().min(1).max(20).default(3),
  reset_timeout_ms: z.number().min(1000).max(3600000).default(DEFAULT_RESET_TIMEOUT_MS),
});

const orchestratorFields = {
  retry_attempts: z.number().min(0).max(10).default(DEFAULT_LLM_RETRY_ATTEMPTS),
  retry_delay_ms: z.number().min(0).max(60000).default(DEFAULT_RETRY_DELAY_MS),
  // 兼容接收旧 breaker 段；缺段不物化，显式空 object 仍保留子字段默认值供诊断。
  circuit_breaker: circuitBreakerConfigSchema.optional(),
};

/** Raw management and explicit migration intake. */
export const llmOrchestratorConfigSchema = z.object({
  primary: llmProviderConfigSchema,
  fallbacks: z.array(llmProviderConfigSchema).optional(),
  ...orchestratorFields,
});

/** Resolved runtime reads reject legacy connection behavior instead of bypassing repair. */
export const llmOrchestratorRuntimeConfigSchema = z.object({
  primary: strictLLMProviderConfigSchema,
  fallbacks: z.array(strictLLMProviderConfigSchema).optional(),
  ...orchestratorFields,
});
