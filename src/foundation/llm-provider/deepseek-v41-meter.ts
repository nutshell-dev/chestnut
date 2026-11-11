/** @module L1.LLMProvider.DeepseekV41Meter */
import { Tokenizer } from '@huggingface/tokenizers';
import tokenizerSpec from './tokenizers/deepseek-v41.tokenizer.json' with { type: 'json' };
import { renderDeepseekV41 } from './deepseek-v41-renderer.js';
import type { CompleteInput, InputMeasurement, InputMeterDescriptor, ModelInputMeter } from './input-meter-types.js';
import type { ProviderWireMessage, ToolDefinition } from './types.js';

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32_768;

function makePlainTokenizer(): InstanceType<typeof Tokenizer> {
  const plain = { ...tokenizerSpec, added_tokens: [] };
  return new Tokenizer(plain, {});
}

export function createDeepseekV41Meter(descriptor: InputMeterDescriptor): ModelInputMeter {
  const tokenizer = makePlainTokenizer();
  const specialIds = new Set((tokenizerSpec.added_tokens ?? []).map(token => token.content));
  const cache = new Map<string, number>();
  let cacheBytes = 0;
  const countPlain = (text: string): number => {
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
    descriptor: Object.freeze({ ...descriptor, profile: 'deepseek-v41-flash-1017-v1' }),
    measure(input: CompleteInput): InputMeasurement {
      try {
        const segments = renderDeepseekV41({
          messages: input.messages as ProviderWireMessage[],
          ...(input.system !== undefined && { system: input.system }),
          ...(input.tools !== undefined && { tools: input.tools as ToolDefinition[] }),
          thinking: { type: 'enabled' },
          output_config: { effort: 'high' },
        });
        const tokens = segments.reduce((sum, segment) => {
          if (segment.kind === 'plain') return sum + countPlain(segment.text);
          if (!specialIds.has(segment.text)) throw new Error(`unknown special token ${segment.text}`);
          return sum + 1;
        }, 0);
        return { kind: 'counted', tokens, method: 'deepseek-v41-template' };
      } catch (error) {
        // silent: unsupported projections are returned as an explicit unavailable measurement.
        return { kind: 'unavailable', reason: `deepseek_v41_projection_failed:${String(error)}` };
      }
    },
  };
}
