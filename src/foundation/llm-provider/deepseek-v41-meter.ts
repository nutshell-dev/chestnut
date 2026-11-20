/** @module L1.LLMProvider.DeepseekV41Meter */
import { Tokenizer } from '@huggingface/tokenizers';
import tokenizerSpec from './tokenizers/deepseek-v41.tokenizer.json' with { type: 'json' };
import provenance from './tokenizers/provenance.json' with { type: 'json' };
import type {
  CompleteInput,
  InputMeasurement,
  InputMeterDescriptor,
  ModelInputMeter,
} from './input-meter-types.js';
import { COMMON_INPUT_PROJECTION_REVISION, commonInputTextSegments, CommonInputProjectionUnsupported } from './common-input-projection.js';
import { acquireInputMeterAsset } from './input-meter-asset.js';

export const DEEPSEEK_V41_TEXT_METHOD = 'deepseek-v41-text' as const;
export const DEEPSEEK_V41_ASSET_REVISION = [
  `deepseek-recipe@${provenance.recipe}`,
  provenance.commit,
  `tokenizer-sha256:${provenance.tokenizerSha256}`,
  `hf-tokenizers@${provenance.hfTokenizer}`,
].join('+');

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

/** Measure common input content without reconstructing a provider chat template. */
const textSegments = commonInputTextSegments;

function makePlainTokenizer(): InstanceType<typeof Tokenizer> {
  const plain = { ...tokenizerSpec, added_tokens: [] };
  return new Tokenizer(plain, {});
}

function stableReason(error: unknown): string {
  if (error instanceof DeepseekV41EstimateUnsupported || error instanceof CommonInputProjectionUnsupported) {
    return error.reason;
  }
  return `encoding_failed:${error instanceof Error ? error.name : 'UnknownError'}`;
}

export function createDeepseekV41Meter(
  descriptor: Readonly<InputMeterDescriptor>,
  tokenizerFactory: () => InstanceType<typeof Tokenizer> = makePlainTokenizer,
): ModelInputMeter {
  const asset = acquireInputMeterAsset(
    descriptor.profile,
    DEEPSEEK_V41_ASSET_REVISION,
    COMMON_INPUT_PROJECTION_REVISION,
    tokenizerFactory,
  );
  let assetError: unknown;
  const getTokenizer = (): InstanceType<typeof Tokenizer> => {
    if (assetError !== undefined) throw new DeepseekV41EstimateUnsupported('asset_initialization_failed');
    if (!asset.encoder) {
      try {
        asset.encoder = tokenizerFactory();
      } catch (error) {
        // silent: retained as stable typed unavailable on every measurement.
        assetError = error;
        throw new DeepseekV41EstimateUnsupported('asset_initialization_failed');
      }
    }
    return asset.encoder;
  };
  const countPlain = (text: string): number => {
    const activeTokenizer = getTokenizer();
    const conflict = PLAIN_TEXT_CONFLICTS.find(token => text.includes(token));
    if (conflict) unsupported(`control_token_in_text:${conflict}`);
    if (!text) return 0;
    const hit = asset.textCache.read(text);
    if (hit !== undefined) return hit;
    const count = activeTokenizer.encode(text, { add_special_tokens: false }).ids.length;
    asset.textCache.write(text, count);
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
