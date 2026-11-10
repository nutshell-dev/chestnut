/**
 * @module L4.LLMConfiguration.Selection
 *
 * 主配置覆盖、备用顺序与 orchestrator 配置转换的唯一解释入口。
 */
import type { z } from 'zod';
import {
  llmOrchestratorConfigSchema,
  type LLMOrchestratorConfig,
} from '../../foundation/llm-orchestrator/index.js';
import {
  toProviderConfig,
  type LLMProviderConfig,
} from '../../foundation/llm-provider/index.js';

export type SharedLLMInput = z.input<typeof llmOrchestratorConfigSchema>;
export type SharedLLM = z.output<typeof llmOrchestratorConfigSchema>;

export interface LLMGlobalConfigView {
  llm: SharedLLM;
}

export interface LLMClawConfigView {
  llm?: { primary?: LLMProviderConfig };
}

export interface LLMConfigInput {
  llm: SharedLLMInput;
}

/** 将 global 与可选 claw 的 LLM 视图转换为运行配置。 */
export function resolveLLMConfig(
  globalConfig: LLMGlobalConfigView,
  clawConfig?: LLMClawConfigView,
): LLMOrchestratorConfig {
  const llm = globalConfig.llm;
  const cb = llm.circuit_breaker;
  return {
    primary: toProviderConfig(clawConfig?.llm?.primary ?? llm.primary),
    fallbacks: (llm.fallbacks ?? []).map(toProviderConfig),
    maxAttempts: llm.retry_attempts,
    retryDelayMs: llm.retry_delay_ms,
    events: { emit: () => {} },
    circuitBreaker: cb ? {
      failureThreshold: cb.failure_threshold,
      resetTimeoutMs: cb.reset_timeout_ms,
    } : undefined,
  };
}
