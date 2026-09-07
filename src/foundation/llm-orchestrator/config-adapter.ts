/**
 * Phase 10 Step B: LLM config adapters (迁自 foundation/config/adapters.ts)
 *
 * 业务归 LLM、本模块 own LLM yaml schema ↔ runtime ProviderConfig 转换。
 * Content 与 foundation/config/adapters.ts 等同（迁不改）、import path 改自家。
 * phase 298: buildLLMConfig 迁 assembly/config-load.ts (root config 装配业务归 L6 Assembly)。
 */
import type { ProviderConfig } from '../llm-provider/index.js';
import { resolvePreset } from '../llm-provider/index.js';
import type { LLMProviderConfig } from './llm-provider-config-schema.js';

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
    // phase 1797: transport 传播 —— yaml 显式 > preset 单源默认 > factory 迁移默认(fetch+audit)
    transport: p.transport ?? preset.transport,
    reasoningEffort: p.reasoning_effort,
  };
}
