/** @module L1.LLMProvider.DeepseekV41Meter */
import { Tokenizer } from '@huggingface/tokenizers';
import tokenizerSpec from './tokenizers/deepseek-v41.tokenizer.json' with { type: 'json' };
import provenance from './tokenizers/provenance.json' with { type: 'json' };
import type {
  CompleteInput,
  CompleteInputMessage,
  InputMeasurement,
  InputMeterDescriptor,
  ModelInputMeter,
} from './input-meter-types.js';

export const DEEPSEEK_V41_TEXT_METHOD = 'deepseek-v41-text' as const;
export const DEEPSEEK_V41_ASSET_REVISION = [
  `deepseek-recipe@${provenance.recipe}`,
  provenance.commit,
  `tokenizer-sha256:${provenance.tokenizerSha256}`,
  `hf-tokenizers@${provenance.hfTokenizer}`,
].join('+');

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32_768;
const PLAIN_TEXT_CONFLICTS = Object.freeze(
  tokenizerSpec.added_tokens.map(token => token.content),
);

class DeepseekV41EstimateUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'DeepseekV41EstimateUnsupported';
  }
}

function unsupported(reason: string): never {
  throw new DeepseekV41EstimateUnsupported(reason);
}

function textFromMessage(message: CompleteInputMessage): string {
  const role = message.role as string;
  if (role !== 'system' && role !== 'user' && role !== 'assistant') unsupported(`role:${role}`);
  if (typeof message.content !== 'string') unsupported('non_text_content');
  return message.content;
}

/** Measure input content itself, without reconstructing a provider chat template. */
function textSegments(input: CompleteInput): readonly string[] {
  if (input.tools?.length) unsupported('tools');
  if (!Array.isArray(input.messages)) unsupported('messages_not_array');
  if (input.system !== undefined && typeof input.system !== 'string') unsupported('non_text_system');
  if (input.system !== undefined && input.messages.some(message => message.role === 'system')) {
    unsupported('duplicate_system');
  }
  return [
    ...(input.system !== undefined ? [input.system] : []),
    ...input.messages.map(textFromMessage),
  ];
}

function makePlainTokenizer(): InstanceType<typeof Tokenizer> {
  const plain = { ...tokenizerSpec, added_tokens: [] };
  return new Tokenizer(plain, {});
}

function stableReason(error: unknown): string {
  if (error instanceof DeepseekV41EstimateUnsupported) return error.reason;
  return `encoding_failed:${error instanceof Error ? error.name : 'UnknownError'}`;
}

export function createDeepseekV41Meter(
  descriptor: Readonly<InputMeterDescriptor>,
): ModelInputMeter {
  const cache = new Map<string, number>();
  let cacheBytes = 0;
  let tokenizer: InstanceType<typeof Tokenizer> | undefined;
  let assetError: unknown;
  const countPlain = (text: string): number => {
    if (assetError !== undefined) throw new DeepseekV41EstimateUnsupported('asset_initialization_failed');
    if (!tokenizer) {
      try {
        tokenizer = makePlainTokenizer();
      } catch (error) {
        // silent: retained as stable typed unavailable on every measurement.
        assetError = error;
        throw new DeepseekV41EstimateUnsupported('asset_initialization_failed');
      }
    }
    const conflict = PLAIN_TEXT_CONFLICTS.find(token => text.includes(token));
    if (conflict) unsupported(`control_token_in_text:${conflict}`);
    if (!text) return 0;
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
    measure(input: CompleteInput): InputMeasurement {
      try {
        countPlain('');
        const tokens = textSegments(input).reduce((sum, text) => sum + countPlain(text), 0);
        return {
          kind: 'estimated',
          tokens,
          method: DEEPSEEK_V41_TEXT_METHOD,
          reason: 'context_trim_only:deepseek_v41_text',
        };
      } catch (error) {
        // silent: unsupported input and local asset/encoding failures become typed unavailable.
        return {
          kind: 'unavailable',
          reason: `deepseek_v41_text_estimate_unavailable:${stableReason(error)}`,
        };
      }
    },
  };
}
