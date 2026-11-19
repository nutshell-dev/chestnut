/** Explicit provider wire protocols accepted by the persisted configuration. */

export const API_FORMATS = [
  // Historical Chestnut names remain explicit aliases for custom endpoints.
  'anthropic',
  'openai',
  'gemini',
  // pi-ai catalog protocol ids. No protocol is inferred from a provider or model.
  'anthropic-messages',
  'azure-openai-responses',
  'bedrock-converse-stream',
  'cloudflare-workers-ai-system-one',
  'google-generative-ai',
  'google-vertex',
  'llama-cpp-classify',
  'mistral-conversations',
  'openai-codex-responses',
  'openai-completions',
  'openai-decisions',
  'openai-responses',
  'openrouter-images',
  'pi-messages',
  'typesafe-system-one',
] as const;

export type ApiFormat = typeof API_FORMATS[number];
export type AuthProfile = 'api_key' | 'ambient' | 'oauth';
