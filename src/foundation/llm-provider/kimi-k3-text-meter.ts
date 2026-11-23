/** @module L1.LLMProvider.KimiK3TextMeter */
import { Tiktoken, type TiktokenBPE } from 'js-tiktoken/lite';
import kimiK3Bpe from './tokenizers/kimi-k3.tiktoken.json' with { type: 'json' };
import provenance from './tokenizers/kimi-k3.provenance.json' with { type: 'json' };
import type {
  CompleteInput,
  InputMeasurement,
  InputMeterDescriptor,
  MeterQualification,
  ModelInputMeter,
} from './input-meter-types.js';
import { COMMON_INPUT_PROJECTION_REVISION, commonInputTextSegments, CommonInputProjectionUnsupported } from './common-input-projection.js';
import { acquireInputMeterAsset } from './input-meter-asset.js';

export const KIMI_K3_TEXT_METHOD = 'kimi-k3-text' as const;
export const KIMI_K3_TEXT_ASSET_REVISION = [
  `${provenance.source.repository}:tiktoken.model:${provenance.source.modelSha256}`,
  `asset-sha256:${provenance.conversion.assetSha256}`,
  `conversion:${provenance.conversion.version}`,
].join(':');
/** Legacy descriptor field: this meter performs no final-wire projection. */
export const KIMI_K3_TEXT_PROJECTION_REVISION = 'estimate-only:no-final-wire-projection' as const;
export const KIMI_K3_TEXT_PROFILE_ID = 'kimi-k3-text-v1' as const;

const CONTROL_TOKENS = ['<|open|>', '<|close|>', '<|sep|>', '<|end_of_msg|>'] as const;
type KimiK3Encoder = Pick<Tiktoken, 'encode'>;
type KimiK3EncoderFactory = () => KimiK3Encoder;

// Conservative chunks stay below the official 400k encode limit and cap every
// whitespace/non-whitespace run below the official 25k panic guard as well.
const MAX_CHUNK_CODE_POINTS = 25_000;
const TEXT_ESTIMATE_REASON = 'context_trim_only:kimi_k3_text' as const;

class KimiK3TextEstimateUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'KimiK3TextEstimateUnsupported';
  }
}

function unsupported(reason: string): never {
  throw new KimiK3TextEstimateUnsupported(reason);
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
  if (error instanceof KimiK3TextEstimateUnsupported || error instanceof CommonInputProjectionUnsupported) {
    return error.reason;
  }
  return `encoding_failed:${error instanceof Error ? error.name : 'UnknownError'}`;
}

function defaultEncoderFactory(): KimiK3Encoder {
  return new Tiktoken(kimiK3Bpe as TiktokenBPE);
}

/** Local common-input estimate; never a provider usage or final-wire count. */
export function createKimiK3TextMeter(
  descriptor: Readonly<InputMeterDescriptor>,
  encoderFactory: KimiK3EncoderFactory = defaultEncoderFactory,
): ModelInputMeter {
  const asset = acquireInputMeterAsset<KimiK3Encoder>(
    descriptor.profile,
    KIMI_K3_TEXT_ASSET_REVISION,
    COMMON_INPUT_PROJECTION_REVISION,
    encoderFactory,
  );
  let assetError: unknown;

  function getEncoder(): KimiK3Encoder {
    if (assetError !== undefined) throw new KimiK3TextEstimateUnsupported('asset_initialization_failed');
    if (!asset.encoder) {
      try {
        const candidate = encoderFactory();
        for (const token of CONTROL_TOKENS) {
          if (candidate.encode(token, [token], []).length !== 1) {
            throw new Error(`Invalid K3 control token: ${token}`);
          }
        }
        asset.encoder = candidate;
      } catch (error) {
        // silent: retained as meter-local state and exposed as typed unavailable on every measure.
        assetError = error;
        throw new KimiK3TextEstimateUnsupported('asset_initialization_failed');
      }
    }
    return asset.encoder;
  }

  function countText(textValue: string): number {
    if (!textValue) return 0;
    const hit = asset.textCache.read(textValue);
    if (hit !== undefined) return hit;
    const controlInText = CONTROL_TOKENS.find(token => textValue.includes(token));
    if (controlInText) unsupported(`control_token_in_text:${controlInText}`);
    const activeEncoder = getEncoder();
    let count = 0;
    for (const chunk of textChunks(textValue)) {
      count += activeEncoder.encode(chunk, [], [...CONTROL_TOKENS]).length;
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
          method: KIMI_K3_TEXT_METHOD,
          tokens,
          reason: TEXT_ESTIMATE_REASON,
        };
      } catch (error) {
        // silent: unsupported input and local asset/encoding failures become typed unavailable.
        return {
          kind: 'unavailable',
          reason: `kimi_k3_text_estimate_unavailable:${stableReason(error)}`,
        };
      }
    },
  };
}

/** Model-family membership is resolved centrally from the model name alone. */
export const kimiK3TextInputProfile = Object.freeze({
  id: KIMI_K3_TEXT_PROFILE_ID,
  family: 'kimi' as const,
  descriptor(): MeterQualification {
    return {
      kind: 'estimated',
      method: KIMI_K3_TEXT_METHOD,
      projection: KIMI_K3_TEXT_PROJECTION_REVISION,
      assetRevision: KIMI_K3_TEXT_ASSET_REVISION,
      reason: TEXT_ESTIMATE_REASON,
      limits: Object.freeze({ supportedTools: 'declared' }),
    };
  },
  create(descriptor: Readonly<InputMeterDescriptor>): ModelInputMeter {
    return createKimiK3TextMeter(descriptor);
  },
});
