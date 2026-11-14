/** @module L1.LLMProvider.DeepseekV41Meter */
import { Tokenizer } from '@huggingface/tokenizers';
import tokenizerSpec from './tokenizers/deepseek-v41.tokenizer.json' with { type: 'json' };
import { renderDeepseekV41 } from './deepseek-v41-renderer.js';
import type { CompleteInput, InputMeasurement, InputMeterDescriptor, ModelInputMeter } from './input-meter-types.js';
import type { DeepseekInputProjection } from './deepseek-input-projection.js';

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32_768;

function makePlainTokenizer(): InstanceType<typeof Tokenizer> {
  const plain = { ...tokenizerSpec, added_tokens: [] };
  return new Tokenizer(plain, {});
}

export function createDeepseekV41Meter(
  descriptor: Readonly<InputMeterDescriptor>,
  project: DeepseekInputProjection,
): ModelInputMeter {
  const specialIds = new Set((tokenizerSpec.added_tokens ?? []).map(token => token.content));
  const cache = new Map<string, number>();
  let cacheBytes = 0;
  let tokenizer: InstanceType<typeof Tokenizer> | undefined;
  let assetError: unknown;
  const countPlain = (text: string): number => {
    if (assetError !== undefined) throw assetError;
    if (!tokenizer) {
      try {
        tokenizer = makePlainTokenizer();
      } catch (error) {
        assetError = error;
        throw error;
      }
    }
    const hit = cache.get(text);
    if (hit !== undefined) {
      cache.delete(text); cache.set(text, hit); return hit;
    }
    const count = tokenizer.encode(text, { add_special_tokens: false }).ids.length;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= MAX_CACHE_BYTES) {
      while (cacheBytes + bytes > MAX_CACHE_BYTES || cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cacheBytes -= Buffer.byteLength(oldest, 'utf8'); cache.delete(oldest);
      }
      cache.set(text, count); cacheBytes += bytes;
    }
    return count;
  };
  return {
    descriptor,
    capability: { kind: 'complete_only' },
    project: (input: CompleteInput): unknown => project(input),
    measure(input: CompleteInput): InputMeasurement {
      try {
        const segments = renderDeepseekV41(project(input));
        const tokens = segments.reduce((sum, segment) => {
          if (segment.kind === 'plain') return sum + countPlain(segment.text);
          if (!specialIds.has(segment.text)) throw new Error(`unknown special token ${segment.text}`);
          return sum + 1;
        }, 0);
        return { kind: 'counted', tokens, method: 'deepseek-v41-template' };
      } catch (error) {
        // silent: converted to typed unavailable below; never fall back to estimates.
        // Unsupported projections and fixed-asset failures stay explicit.
        return { kind: 'unavailable', reason: `deepseek_v41_projection_failed:${String(error)}` };
      }
    },
  };
}
