/**
 * Phase 10 Step B: LLM config adapters (迁自 foundation/config/adapters.ts)
 *
 * 业务归 LLM、本模块 own LLM yaml schema ↔ runtime ProviderConfig 转换。
 * Content 与 foundation/config/adapters.ts 等同（迁不改）、import path 改自家。
 * phase 298: buildLLMConfig 迁 assembly/config-load.ts (root config 装配业务归 L6 Assembly)。
 */
import type { ProviderConfig } from '../llm-provider/index.js';
import {
  resolvePreset,
  catalogProviderEntry,
  deriveCatalogAuthProfile,
  validateCatalogAuthProfile,
  catalogModelKnown,
  CatalogModelNotFoundError,
} from '../llm-provider/index.js';
import type { LLMProviderConfig } from './llm-provider-config-schema.js';

/** bare env var 名（应写 ${...} 引用）检测——preset 与显式 catalog 路径共用。 */
function assertNotBareEnvVar(apiKey: string | undefined, display: string): void {
  if (apiKey && /^[A-Z][A-Z0-9_]{3,}$/.test(apiKey)) {
    throw new Error(
      `Provider "${display}": api_key looks like a bare environment variable name ("${apiKey}"). ` +
      `Use \${${apiKey}} to reference it.`
    );
  }
}

// Convert snake_case to camelCase, resolve preset
export function toProviderConfig(p: LLMProviderConfig): ProviderConfig {
  // Phase 1927 Step D：显式 catalog provider 路径（provider_id 与 preset 互斥；
  // provider 合法性 / model 静态 seed / auth_profile 兼容均由 catalog-strategy 裁决）。
  if (p.provider_id) {
    if (p.preset) {
      throw new Error(
        `Provider "${p.label ?? p.provider_id}": "provider_id" and "preset" are mutually exclusive ` +
        `(provider_id=${p.provider_id}, preset=${p.preset}) — keep only one`,
      );
    }
    const providerId = p.provider_id;
    catalogProviderEntry(providerId); // 未知 id loud（typed UnknownCatalogProviderError）
    if (!p.model || p.model === 'auto') {
      throw new Error(
        `Provider "${p.label ?? providerId}": explicit catalog provider (provider_id) requires an explicit "model" ` +
        `from the provider's static catalog (no "auto" default without a preset)`,
      );
    }
    if (!catalogModelKnown(providerId, p.model)) {
      throw new CatalogModelNotFoundError(providerId, p.model);
    }
    const authProfile = p.auth_profile ?? deriveCatalogAuthProfile(providerId);
    validateCatalogAuthProfile(providerId, authProfile);
    assertNotBareEnvVar(p.api_key, p.label ?? providerId);

    return {
      name: p.label ?? providerId,
      apiKey: p.api_key,
      baseUrl: p.base_url,
      model: p.model,
      maxTokens: p.max_tokens,
      temperature: p.temperature,
      timeoutMs: p.timeout_ms,
      thinking: p.thinking,
      thinkingBudgetTokens: p.thinking_budget_tokens,
      thinkingMode: p.thinking_mode,
      thinkingEffort: p.thinking_effort,
      extraHeaders: p.extra_headers,
      dropThinkingBlocks: p.drop_thinking_blocks,
      // 显式 catalog 路径无自建 Model 回退：apiFormat 缺席（model 已保证 catalog 命中）
      authProfile,
      reasoningEffort: p.reasoning_effort,
      piAiProvider: providerId,
    };
  }

  const presetId = p.preset;
  if (!presetId) {
    throw new Error('Provider config must have "preset" field');
  }

  const preset = resolvePreset(presetId);

  // Detect bare env var names that should be wrapped in ${...}
  assertNotBareEnvVar(p.api_key, p.label ?? presetId);

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
    // Phase 1926 Step D：认证装配类别透传（ambient/oauth 时 apiKey 合法缺席）
    authProfile: preset.authProfile,
    reasoningEffort: p.reasoning_effort,
    // Phase 1925 Step C：pi-ai catalog provider id 显式映射（无对应者 undefined → 自建 Model）
    piAiProvider: preset.piAiProvider,
  };
}
