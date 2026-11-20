/**
 * Revisioned legacy provider aliases used only for context-window disambiguation.
 * Unknown/ambiguous/custom inputs return undefined; no fuzzy matching or fallback
 * to wire identity, provider login, endpoint or authentication is permitted.
 */
export const CATALOG_PROVIDER_ALIAS_REVISION = 'legacy-catalog-provider-aliases@1';

const CATALOG_PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  moonshot: 'moonshotai-cn',
  gemini: 'google',
  grok: 'xai',
  'openrouter-anthropic': 'openrouter',
  kimi: 'kimi-coding',
  qwen: 'qwen-token-plan',
});

export function resolveLegacyCatalogProviderAlias(providerId: string): string | undefined {
  return CATALOG_PROVIDER_ALIASES[providerId];
}
