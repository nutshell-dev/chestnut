/**
 * Explicit persisted LLM provider configuration.
 * Legacy preset/provider documents are accepted only by L4's migration capability.
 */
import { z } from 'zod';
import { THINKING_LEVELS } from './thinking-levels.js';
import { DEFAULT_LLM_TIMEOUT_MS } from './defaults.js';
import { API_FORMATS } from './api-format.js';

/** Reserved display sentinel; persisted user labels must remain distinguishable from a missing label. */
export const PROVIDER_NO_LABEL_SENTINEL = '(no label)';

const providerConfigFields = {
  provider_id: z.string().min(1),
  api_format: z.enum(API_FORMATS),
  auth_profile: z.enum(['api_key', 'ambient', 'oauth']),
  label: z.string().refine(value => value !== PROVIDER_NO_LABEL_SENTINEL, {
    message: 'label must not use the reserved no-label sentinel',
  }).optional(),
  // Raw legacy reads retain a missing reference so the CLI can repair the slot.
  api_key: z.string().min(1, 'api_key must not be empty').optional(),
  base_url: z.string().min(1).optional(),
  model: z.string().min(1).refine(value => value !== 'auto', {
    message: 'model must be explicit (auto is only accepted by legacy migration)',
  }),
  // Explicit metadata lookup hints; neither field participates in wire resolution.
  catalog_provider: z.string().min(1).optional(),
  catalog_model: z.string().min(1).optional(),
  max_tokens: z.number().min(1).optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  timeout_ms: z.number().min(1000).max(600000).default(DEFAULT_LLM_TIMEOUT_MS),
  thinking: z.boolean().optional(),
  thinking_budget_tokens: z.number().min(1).optional(),
  thinking_mode: z.enum(['adaptive', 'enabled']).optional(),
  thinking_effort: z.enum(THINKING_LEVELS).optional(),
  extra_headers: z.record(z.string()).optional(),
  drop_thinking_blocks: z.boolean().optional(),
  reasoning_effort: z.enum(THINKING_LEVELS).optional(),
};

function validateCatalogHints(config: { catalog_provider?: string; catalog_model?: string }, context: z.RefinementCtx): void {
  if ((config.catalog_provider === undefined) !== (config.catalog_model === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: config.catalog_provider === undefined ? ['catalog_provider'] : ['catalog_model'],
      message: 'catalog_provider and catalog_model must be provided together',
    });
  }
}

/** Raw/legacy readable shape. Unsupported connection facts remain repairable by L4. */
export const llmProviderConfigSchema = z.object(providerConfigFields).strict().superRefine(validateCatalogHints);

/** Strict new writes and runtime projection: only reproducible API-key connections are supported. */
export const strictLLMProviderConfigSchema = z.object({
  ...providerConfigFields,
  auth_profile: z.literal('api_key'),
  api_key: z.string().min(1, 'api_key must not be empty'),
  base_url: z.string().min(1),
  extra_headers: z.undefined().optional(),
}).strict().superRefine(validateCatalogHints);

export type LLMProviderConfig = z.infer<typeof llmProviderConfigSchema>;
export type StrictLLMProviderConfig = z.infer<typeof strictLLMProviderConfigSchema>;
