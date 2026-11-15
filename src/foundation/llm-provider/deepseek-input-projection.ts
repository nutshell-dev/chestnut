/** @module L1.LLMProvider.DeepseekInputProjection */
import type * as PiAi from '@earendil-works/pi-ai';
import provenance from './tokenizers/provenance.json' with { type: 'json' };
import { buildPiAiContext } from './pi-ai-wire.js';
import type { CompleteInput, CompleteInputTool } from './input-meter-types.js';
import type { LLMCallOptions, ProviderConfig } from './types.js';

export const DEEPSEEK_PROJECTION_REVISION = 'pi-ai@1.4.0:anthropic-messages:buildApiKeyRequest';
export const DEEPSEEK_V41_ASSET_REVISION = [
  `deepseek-recipe@${provenance.recipe}`,
  provenance.commit,
  `tokenizer-sha256:${provenance.tokenizerSha256}`,
  `hf-tokenizers@${provenance.hfTokenizer}`,
].join('+');

export type DeepseekEffectiveOptions = Pick<
  PiAi.SimpleStreamOptions,
  'maxTokens' | 'temperature' | 'reasoning' | 'thinkingBudgets'
>;
export type DeepseekInputProjection = (input: CompleteInput) => Record<string, unknown>;

type BuildApiKeyRequest = typeof import('@earendil-works/pi-ai/api/anthropic-messages').buildApiKeyRequest;
let buildApiKeyRequest: BuildApiKeyRequest | undefined;
let loadPromise: Promise<void> | undefined;
let loadError: unknown;

/**
 * The concrete SDK module stays behind dynamic import so the CJS bundle has no
 * static pi-ai require. Load failures are reported by measure() as unavailable.
 */
export async function prepareDeepseekInputProjection(): Promise<void> {
  if (buildApiKeyRequest) return;
  loadPromise ??= import('@earendil-works/pi-ai/api/anthropic-messages').then(module => {
    if (typeof module.buildApiKeyRequest !== 'function') {
      throw new Error('pi-ai buildApiKeyRequest is unavailable');
    }
    buildApiKeyRequest = module.buildApiKeyRequest;
    loadError = undefined;
  });
  try {
    await loadPromise;
  } catch (error) {
    // silent: retained and returned as an unavailable measurement by measure().
    loadError = error;
    loadPromise = undefined;
  }
}

/** Bind the exact resolved model/options used by streamSimple to its final API-key payload. */
export function createDeepseekInputProjection(
  config: ProviderConfig,
  model: PiAi.Model<PiAi.Api>,
  effective: DeepseekEffectiveOptions,
): DeepseekInputProjection {
  const anthropicModel = model as PiAi.Model<'anthropic-messages'>;
  return input => {
    if (!buildApiKeyRequest) {
      throw new Error(`deepseek_projection_not_loaded:${String(loadError ?? 'prepare required')}`);
    }
    // buildPiAiContext intentionally accepts only declared client tools. Reject
    // server/deferred tools before that projection can erase their type markers.
    for (const tool of input.tools ?? []) {
      const candidate = tool as CompleteInputTool & { type?: unknown; defer_loading?: unknown };
      if (candidate.type !== undefined || candidate.defer_loading === true) {
        throw new Error('unsupported server/deferred tool');
      }
    }
    // The SDK context builder may omit unknown blocks. Reject them before that
    // projection so multimodal input can never be reported as exactly counted.
    for (const message of input.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const candidate = block as { type?: unknown };
        if (!['text', 'thinking', 'tool_use', 'tool_result'].includes(String(candidate.type))) {
          throw new Error(`unsupported content: ${String(candidate.type)}`);
        }
      }
    }
    const context = buildPiAiContext(config, input as unknown as LLMCallOptions, model);
    const payload = buildApiKeyRequest(anthropicModel, context, effective);
    // Anthropic SDK consumes betas as request headers; the final fetch body does
    // not retain the helper's intermediate `betas` member.
    const request = { ...payload };
    delete request.betas;
    return request;
  };
}
