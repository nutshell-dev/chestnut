/** @module L1.LLMProvider.PiAi.CallOptions */
import type * as PiAi from '@earendil-works/pi-ai';
import type { LLMCallOptions, ProviderConfig } from './types.js';
import type { ThinkingLevel } from './thinking-levels.js';

function reasoningLevel(config: ProviderConfig): ThinkingLevel | undefined {
  if (config.reasoningEffort) return config.reasoningEffort;
  if (config.thinking === false) return undefined;
  if (config.thinkingMode) return config.thinkingEffort ?? 'high';
  if (config.thinking) return config.thinkingEffort ?? 'high';
  return config.thinkingEffort;
}

/** Shared by sending and counting; pi-ai remains responsible for protocol clamping. */
export function buildEffectiveCallOptions(
  config: ProviderConfig,
  options: Pick<LLMCallOptions, 'maxTokens' | 'temperature'>,
  maxTokensOverride?: number,
): Pick<PiAi.SimpleStreamOptions, 'maxTokens' | 'temperature' | 'reasoning' | 'thinkingBudgets'> {
  const reasoning = reasoningLevel(config);
  return {
    maxTokens: maxTokensOverride ?? options.maxTokens ?? config.maxTokens,
    temperature: options.temperature ?? config.temperature,
    ...(reasoning && { reasoning }),
    ...(reasoning && config.thinkingBudgetTokens && {
      thinkingBudgets: { [reasoning]: config.thinkingBudgetTokens },
    }),
  };
}
