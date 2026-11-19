/** @module L1.LLMProvider.Glm53TextMeter */
import type * as PiAi from '@earendil-works/pi-ai';
import { Tokenizer } from '@huggingface/tokenizers';
import glmTokenizerSpec from './tokenizers/glm53.tokenizer.json' with { type: 'json' };
import { CATALOG_REVISION, type CatalogResolution } from './catalog-strategy.js';
import type {
  CompleteInput,
  CompleteInputMessage,
  InputMeasurement,
  InputMeterDescriptor,
  MeterQualification,
  ModelInputMeter,
} from './input-meter-types.js';
import type { ProviderConfig } from './types.js';

export const GLM53_TEXT_METHOD = 'glm5.3-text' as const;
export const GLM53_TEXT_ASSET_REVISION =
  'zai-org/GLM-5.3:tokenizer.json:19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d' as const;
export const GLM53_TEXT_PROJECTION_REVISION = 'glm-text-estimate-v1' as const;
export const GLM53_TEXT_PROFILE_ID = 'glm-text-v1' as const;

const PROJECTION_CONTROLS = ['[gMASK]', '<sop>', '<|system|>', '<|user|>', '<|assistant|>'] as const;
const PROJECTION_CONTROL_IDS: Readonly<Record<string, number>> = Object.freeze({
  '[gMASK]': 154822,
  '<sop>': 154824,
  '<|system|>': 154826,
  '<|user|>': 154827,
  '<|assistant|>': 154828,
});
const ROLE_CONTROLS = Object.freeze({
  system: '<|system|>',
  user: '<|user|>',
  assistant: '<|assistant|>',
} as const);
const PLAIN_TEXT_CONFLICTS = Object.freeze(
  glmTokenizerSpec.added_tokens.map(token => token.content),
);
type ProjectionControl = typeof PROJECTION_CONTROLS[number];
type Glm53TextSegment =
  | { readonly kind: 'control'; readonly text: ProjectionControl }
  | { readonly kind: 'text'; readonly text: string };
type Glm53TextEncoder = Pick<InstanceType<typeof Tokenizer>, 'encode'>;
type Glm53TextEncoderFactory = () => Glm53TextEncoder;

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32_768;
const MAX_CHUNK_CODE_POINTS = 25_000;
const TEXT_ESTIMATE_REASON = 'context_trim_only:glm53_text_projection' as const;

class Glm53TextEstimateUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'Glm53TextEstimateUnsupported';
  }
}

function unsupported(reason: string): never {
  throw new Glm53TextEstimateUnsupported(reason);
}

function text(value: string): readonly Glm53TextSegment[] {
  return value ? [{ kind: 'text', text: value }] : [];
}

function control(value: ProjectionControl): readonly Glm53TextSegment[] {
  return [{ kind: 'control', text: value }];
}

function renderTextMessage(
  role: 'system' | 'user' | 'assistant',
  content: string,
): readonly Glm53TextSegment[] {
  return [
    ...control(ROLE_CONTROLS[role]),
    ...text(content),
    ...text('\n'),
  ];
}

function renderMessage(message: CompleteInputMessage): readonly Glm53TextSegment[] {
  const role = message.role as string;
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    unsupported(`role:${role}`);
  }
  if (typeof message.content !== 'string') unsupported('non_text_content');
  return renderTextMessage(role, message.content);
}

function renderGlm53TextOnly(input: CompleteInput): readonly Glm53TextSegment[] {
  if (input.tools?.length) unsupported('tools');
  if (!Array.isArray(input.messages)) unsupported('messages_not_array');
  if (input.system !== undefined && typeof input.system !== 'string') {
    unsupported('non_text_system');
  }
  if (input.system !== undefined && input.messages.some(message => message.role === 'system')) {
    unsupported('duplicate_system');
  }
  return [
    ...control('[gMASK]'),
    ...control('<sop>'),
    ...(input.system !== undefined ? renderTextMessage('system', input.system) : []),
    ...input.messages.flatMap(renderMessage),
  ];
}

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
  if (error instanceof Glm53TextEstimateUnsupported) return error.reason;
  return `encoding_failed:${error instanceof Error ? error.name : 'UnknownError'}`;
}

function defaultEncoderFactory(): Glm53TextEncoder {
  // Plain text never consumes added tokens; projection controls are counted separately.
  return new Tokenizer({ ...glmTokenizerSpec, added_tokens: [] }, {});
}

/** Local text-only estimate; never a provider usage or final-wire count. */
export function createGlm53TextMeter(
  descriptor: Readonly<InputMeterDescriptor>,
  encoderFactory: Glm53TextEncoderFactory = defaultEncoderFactory,
): ModelInputMeter {
  const cache = new Map<string, number>();
  let cacheBytes = 0;
  let encoder: Glm53TextEncoder | undefined;
  let assetError: unknown;

  function getEncoder(): Glm53TextEncoder {
    if (assetError !== undefined) throw new Glm53TextEstimateUnsupported('asset_initialization_failed');
    if (!encoder) {
      try {
        for (const token of PROJECTION_CONTROLS) {
          const added = glmTokenizerSpec.added_tokens.find(candidate => candidate.content === token);
          if (added?.id !== PROJECTION_CONTROL_IDS[token] || !added.special) {
            throw new Error(`Invalid Glm53 control token: ${token}`);
          }
        }
        encoder = encoderFactory();
      } catch (error) {
        // silent: retained as meter-local state and exposed as typed unavailable on every measure.
        assetError = error;
        throw new Glm53TextEstimateUnsupported('asset_initialization_failed');
      }
    }
    return encoder;
  }

  function countText(textValue: string): number {
    const controlInText = PLAIN_TEXT_CONFLICTS.find(token => textValue.includes(token));
    if (controlInText) unsupported(`control_token_in_text:${controlInText}`);
    if (!textValue) return 0;
    const key = `${GLM53_TEXT_ASSET_REVISION}\0${GLM53_TEXT_PROJECTION_REVISION}\0${textValue}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const activeEncoder = getEncoder();
    let count = 0;
    for (const chunk of textChunks(textValue)) {
      count += activeEncoder.encode(chunk, { add_special_tokens: false }).ids.length;
    }
    const bytes = Buffer.byteLength(key, 'utf8');
    if (bytes <= MAX_CACHE_BYTES) {
      while (cacheBytes + bytes > MAX_CACHE_BYTES || cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cacheBytes -= Buffer.byteLength(oldest, 'utf8');
        cache.delete(oldest);
      }
      cache.set(key, count);
      cacheBytes += bytes;
    }
    return count;
  }

  function countSegment(segment: Glm53TextSegment): number {
    if (segment.kind === 'text') return countText(segment.text);
    getEncoder();
    return 1;
  }

  return {
    descriptor,
    capability: { kind: 'complete_only' },
    measure(input: CompleteInput): InputMeasurement {
      try {
        getEncoder();
        const tokens = renderGlm53TextOnly(input)
          .reduce((sum, segment) => sum + countSegment(segment), 0);
        return {
          kind: 'estimated',
          method: GLM53_TEXT_METHOD,
          tokens,
          reason: TEXT_ESTIMATE_REASON,
        };
      } catch (error) {
        // silent: unsupported input and local asset/encoding failures become typed unavailable.
        return {
          kind: 'unavailable',
          reason: `glm53_text_estimate_unavailable:${stableReason(error)}`,
        };
      }
    },
  };
}

const GLM_PROVIDER_IDS = Object.freeze(['zai', 'zai-coding-cn'] as const);
const GLM_MODEL_FAMILY = /^glm-(?:4\.[5-7]|5(?:\.\d+)?)(?:-[a-z0-9.]+)?$/;

/** Canonical Z.AI identities and matching wire required; display names never qualify. */
export const glm53TextInputProfile = Object.freeze({
  id: GLM53_TEXT_PROFILE_ID,
  matches(model: PiAi.Model<PiAi.Api>, resolution: CatalogResolution): boolean {
    return (resolution.kind === 'catalog_model' || resolution.kind === 'metadata_only')
      && resolution.revision === CATALOG_REVISION
      && resolution.providerId !== undefined
      && (GLM_PROVIDER_IDS as readonly string[]).includes(resolution.providerId)
      && GLM_MODEL_FAMILY.test(resolution.modelId)
      && model.id === resolution.modelId
      && resolution.wire.model === model.id
      && resolution.wire.api === String(model.api);
  },
  descriptor(): MeterQualification {
    return {
      kind: 'estimated',
      method: GLM53_TEXT_METHOD,
      projection: GLM53_TEXT_PROJECTION_REVISION,
      assetRevision: GLM53_TEXT_ASSET_REVISION,
      reason: TEXT_ESTIMATE_REASON,
      limits: Object.freeze({ supportedTools: 'none' }),
    };
  },
  create(input: {
    readonly descriptor: Readonly<InputMeterDescriptor>;
    readonly config: ProviderConfig;
    readonly model: PiAi.Model<PiAi.Api>;
  }): ModelInputMeter {
    return createGlm53TextMeter(input.descriptor);
  },
});
