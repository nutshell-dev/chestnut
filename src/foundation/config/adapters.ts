/**
 * Config → runtime type adapters / phase 500 sub-file extraction
 *
 * Config → runtime type adapters / phase 500 sub-file extraction
 */

import type { LLMOrchestratorConfig } from '../llm-orchestrator/index.js';
import type { ProviderConfig } from '../llm-provider/types.js';
import { resolvePreset } from '../llm-provider/presets.js';
import {
  type LLMProviderConfig,
  type ClawGlobalConfig,
  type ClawConfig,
} from './schemas.js';

// Convert snake_case to camelCase, resolve preset
export function toProviderConfig(p: LLMProviderConfig): ProviderConfig {
  const presetId = p.preset;
  if (!presetId) {
    throw new Error('Provider config must have "preset" field');
  }

  const preset = resolvePreset(presetId);

  // Detect bare env var names that should be wrapped in ${...}
  if (p.api_key && /^[A-Z][A-Z0-9_]{3,}$/.test(p.api_key)) {
    throw new Error(
      `Provider "${p.label ?? presetId}": api_key looks like a bare environment variable name ("${p.api_key}"). ` +
      `Use \${${p.api_key}} to reference it.`
    );
  }

  return {
    name: p.label ?? presetId,
    apiKey: p.api_key,
    baseUrl: p.base_url ?? preset.defaultBaseUrl,
    model: (!p.model || p.model === 'auto') ? (preset.defaultModel ?? 'unknown') : p.model,
    maxTokens: p.max_tokens,
    temperature: p.temperature,
    timeoutMs: p.timeout_ms,
    thinking: p.thinking,
    thinkingBudgetTokens: p.thinking_budget_tokens,
    thinkingMode: p.thinking_mode,
    thinkingEffort: p.thinking_effort,
    extraHeaders: p.extra_headers,
    dropThinkingBlocks: p.drop_thinking_blocks,
    apiFormat: preset.apiFormat,
    reasoningEffort: p.reasoning_effort,
  };
}

// Build LLMOrchestratorConfig from global + claw config
export function buildLLMConfig(
  globalConfig: ClawGlobalConfig,
  clawConfig?: ClawConfig
): LLMOrchestratorConfig {
  // Use claw's primary if provided, otherwise use global's primary
  const primaryProvider = clawConfig?.llm?.primary
    ? toProviderConfig(clawConfig.llm.primary)
    : toProviderConfig(globalConfig.llm.primary);

  const fallbackList = globalConfig.llm.fallbacks ?? [];

  // Circuit breaker config
  const cb = globalConfig.llm.circuit_breaker;

  return {
    primary: primaryProvider,
    fallbacks: fallbackList.map(toProviderConfig),
    maxAttempts: globalConfig.llm.retry_attempts,
    retryDelayMs: globalConfig.llm.retry_delay_ms,
    events: { emit: () => {} },
    circuitBreaker: cb ? {
      failureThreshold: cb.failure_threshold,
      resetTimeoutMs: cb.reset_timeout_ms,
    } : undefined,
  };
}
