/** @module L1.LLMProvider.PiAi.CallOptions */
import type * as PiAi from '@earendil-works/pi-ai';
import type { LLMCallOptions, ProviderCallDefaults, ProviderConfig } from './types.js';
import type { ThinkingLevel } from './thinking-levels.js';

function reasoningLevel(config: ProviderCallDefaults): ThinkingLevel | undefined {
  if (config.reasoningEffort) return config.reasoningEffort;
  if (config.thinking === false) return undefined;
  if (config.thinkingMode) return config.thinkingEffort ?? 'high';
  if (config.thinking) return config.thinkingEffort ?? 'high';
  return config.thinkingEffort;
}

/** Shared by sending and counting; pi-ai remains responsible for protocol clamping. */
export function buildEffectiveCallOptions(
  config: ProviderConfig,
  options: Pick<LLMCallOptions, 'maxTokens' | 'temperature' | 'callDefaults'>,
  maxTokensOverride?: number,
): Pick<PiAi.SimpleStreamOptions, 'maxTokens' | 'temperature' | 'reasoning' | 'thinkingBudgets'> {
  const defaults = options.callDefaults ?? config;
  const reasoning = reasoningLevel(defaults);
  const maxTokens = maxTokensOverride ?? options.maxTokens ?? defaults.maxTokens;
  return {
    ...(maxTokens !== undefined && { maxTokens }),
    temperature: options.temperature ?? defaults.temperature ?? 0.7,
    ...(reasoning && { reasoning }),
    ...(reasoning && defaults.thinkingBudgetTokens !== undefined && {
      thinkingBudgets: { [reasoning]: defaults.thinkingBudgetTokens },
    }),
  };
}
