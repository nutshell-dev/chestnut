/** @module L1.LLMProvider.QwenTextMeter */
import { Tokenizer } from '@huggingface/tokenizers';
import qwenTokenizerSpec from './tokenizers/qwen3.8.tokenizer.json' with { type: 'json' };
import type {
  CompleteInput,
  InputMeasurement,
  InputMeterDescriptor,
  MeterQualification,
  ModelInputMeter,
} from './input-meter-types.js';
import { COMMON_INPUT_PROJECTION_REVISION, commonInputTextSegments, CommonInputProjectionUnsupported } from './common-input-projection.js';
import { acquireInputMeterAsset } from './input-meter-asset.js';

export const QWEN3_8_TEXT_METHOD = 'qwen3.8-text' as const;
export const QWEN3_8_TEXT_ASSET_REVISION =
  'Qwen/Qwen3.8-27B:tokenizer.json:0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3' as const;
/** Legacy descriptor field: this meter performs no final-wire projection. */
export const QWEN3_8_TEXT_PROJECTION_REVISION = 'estimate-only:no-final-wire-projection' as const;
export const QWEN3_8_TEXT_PROFILE_ID = 'qwen-text-v1' as const;

const PROJECTION_CONTROLS = ['<|im_start|>', '<|im_end|>'] as const;
const PROJECTION_CONTROL_IDS: Readonly<Record<string, number>> = Object.freeze({
  '<|im_start|>': 248045,
  '<|im_end|>': 248046,
});
const PLAIN_TEXT_CONFLICTS = Object.freeze(
  qwenTokenizerSpec.added_tokens.map(token => token.content),
);
type QwenTextEncoder = Pick<InstanceType<typeof Tokenizer>, 'encode'>;
type QwenTextEncoderFactory = () => QwenTextEncoder;

const MAX_CHUNK_CODE_POINTS = 25_000;
const TEXT_ESTIMATE_REASON = 'context_trim_only:qwen_text' as const;

class QwenTextEstimateUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'QwenTextEstimateUnsupported';
  }
}

function unsupported(reason: string): never {
  throw new QwenTextEstimateUnsupported(reason);
}

/** Common-input estimate; provider chat markup is deliberately not reconstructed. */
const textSegments = commonInputTextSegments;

/** Split on Unicode code-point boundaries without quadratic string concatenation. */
function* textChunks(textValue: string): Generator<string> {
  let chunkStart = 0;
  let offset = 0;
  let chunkLength = 0;
  for (const character of textValue) {
    if (chunkLength === MAX_CHUNK_CODE_POINTS) {
      yield textValue.slice(chunkStart, offset);
      chunkStart = offset;
      chunkLength = 0;
    }
    offset += character.length;
    chunkLength += 1;
  }
  if (chunkStart < textValue.length) yield textValue.slice(chunkStart);
}

function stableReason(error: unknown): string {
  if (error instanceof QwenTextEstimateUnsupported || error instanceof CommonInputProjectionUnsupported) {
    return error.reason;
  }
  return `encoding_failed:${error instanceof Error ? error.name : 'UnknownError'}`;
}

function defaultEncoderFactory(): QwenTextEncoder {
  // Added tokens are disabled so their textual spellings are never wire syntax.
  return new Tokenizer({ ...qwenTokenizerSpec, added_tokens: [] }, {});
}

/** Local common-input estimate; never a provider usage or final-wire count. */
export function createQwenTextMeter(
  descriptor: Readonly<InputMeterDescriptor>,
  encoderFactory: QwenTextEncoderFactory = defaultEncoderFactory,
): ModelInputMeter {
  const asset = acquireInputMeterAsset<QwenTextEncoder>(
    descriptor.profile,
    QWEN3_8_TEXT_ASSET_REVISION,
    COMMON_INPUT_PROJECTION_REVISION,
    encoderFactory,
  );
  let assetError: unknown;

  function getEncoder(): QwenTextEncoder {
    if (assetError !== undefined) throw new QwenTextEstimateUnsupported('asset_initialization_failed');
    if (!asset.encoder) {
      try {
        for (const token of PROJECTION_CONTROLS) {
          const added = qwenTokenizerSpec.added_tokens.find(candidate => candidate.content === token);
          if (added?.id !== PROJECTION_CONTROL_IDS[token] || !added.special) {
            throw new Error(`Invalid Qwen control token: ${token}`);
          }
        }
        asset.encoder = encoderFactory();
      } catch (error) {
        // silent: retained as meter-local state and exposed as typed unavailable on every measure.
        assetError = error;
        throw new QwenTextEstimateUnsupported('asset_initialization_failed');
      }
    }
    return asset.encoder;
  }

  function countText(textValue: string): number {
    if (!textValue) return 0;
    const hit = asset.textCache.read(textValue);
    if (hit !== undefined) return hit;
    const controlInText = PLAIN_TEXT_CONFLICTS.find(token => textValue.includes(token));
    if (controlInText) unsupported(`control_token_in_text:${controlInText}`);
    const activeEncoder = getEncoder();
    let count = 0;
    for (const chunk of textChunks(textValue)) {
      count += activeEncoder.encode(chunk, { add_special_tokens: false }).ids.length;
    }
    // Cache the whole text only after every chunk has been encoded successfully.
    asset.textCache.write(textValue, count);
    return count;
  }

  return {
    descriptor,
    capability: { kind: 'complete_only' },
    measure(input: CompleteInput): InputMeasurement {
      try {
        getEncoder();
        const tokens = textSegments(input).reduce((sum, text) => sum + countText(text), 0);
        return {
          kind: 'estimated',
          method: QWEN3_8_TEXT_METHOD,
          tokens,
          reason: TEXT_ESTIMATE_REASON,
        };
      } catch (error) {
        // silent: unsupported input and local asset/encoding failures become typed unavailable.
        return {
          kind: 'unavailable',
          reason: `qwen_text_estimate_unavailable:${stableReason(error)}`,
        };
      }
    },
  };
}

/** Model-family membership is resolved centrally from the model name alone. */
export const qwenTextInputProfile = Object.freeze({
  id: QWEN3_8_TEXT_PROFILE_ID,
  family: 'qwen' as const,
  descriptor(): MeterQualification {
    return {
      kind: 'estimated',
      method: QWEN3_8_TEXT_METHOD,
      projection: QWEN3_8_TEXT_PROJECTION_REVISION,
      assetRevision: QWEN3_8_TEXT_ASSET_REVISION,
      reason: TEXT_ESTIMATE_REASON,
      limits: Object.freeze({ supportedTools: 'declared' }),
    };
  },
  create(descriptor: Readonly<InputMeterDescriptor>): ModelInputMeter {
    return createQwenTextMeter(descriptor);
  },
});
