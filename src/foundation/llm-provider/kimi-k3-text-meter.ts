/** @module L1.LLMProvider.KimiK3TextMeter */
import type * as PiAi from '@earendil-works/pi-ai';
import { Tiktoken, type TiktokenBPE } from 'js-tiktoken/lite';
import kimiK3Bpe from './tokenizers/kimi-k3.tiktoken.json' with { type: 'json' };
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

export const KIMI_K3_TEXT_METHOD = 'kimi-k3-text' as const;
export const KIMI_K3_TEXT_ASSET_REVISION =
  'moonshotai/Kimi-K3:tiktoken.model:b6c497a7469b33ced9c38afb1ad6e47f03f5e5dc05f15930799210ec050c5103' as const;
export const KIMI_K3_TEXT_PROJECTION_REVISION = 'kimi-k3-text-xtml-v1' as const;
export const KIMI_K3_TEXT_PROFILE_ID = 'kimi-k3-text-v1' as const;

const CONTROL_TOKENS = ['<|open|>', '<|close|>', '<|sep|>', '<|end_of_msg|>'] as const;
type ControlToken = typeof CONTROL_TOKENS[number];
type KimiK3TextSegment =
  | { readonly kind: 'control'; readonly text: ControlToken }
  | { readonly kind: 'text'; readonly text: string };
type KimiK3Encoder = Pick<Tiktoken, 'encode'>;
type KimiK3EncoderFactory = () => KimiK3Encoder;

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 32_768;
// Conservative chunks stay below the official 400k encode limit and cap every
// whitespace/non-whitespace run below the official 25k panic guard as well.
const MAX_CHUNK_CODE_POINTS = 25_000;
const TEXT_ESTIMATE_REASON = 'context_trim_only:kimi_k3_text_projection' as const;

class KimiK3TextEstimateUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'KimiK3TextEstimateUnsupported';
  }
}

function unsupported(reason: string): never {
  throw new KimiK3TextEstimateUnsupported(reason);
}

function text(value: string): readonly KimiK3TextSegment[] {
  return value ? [{ kind: 'text', text: value }] : [];
}

function control(value: ControlToken): readonly KimiK3TextSegment[] {
  return [{ kind: 'control', text: value }];
}

function escapeAttributeValue(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function openTag(
  tag: string,
  attributes: readonly (readonly [string, string])[] = [],
): readonly KimiK3TextSegment[] {
  return [
    ...control('<|open|>'),
    ...text(tag),
    ...attributes.flatMap(([key, value]) => [
      ...text(` ${key}`),
      ...text('="'),
      ...text(escapeAttributeValue(value)),
      ...text('"'),
    ]),
    ...control('<|sep|>'),
  ];
}

function closeTag(tag: string): readonly KimiK3TextSegment[] {
  return [...control('<|close|>'), ...text(tag), ...control('<|sep|>')];
}

function renderTextMessage(
  role: 'system' | 'user' | 'assistant',
  content: string,
): readonly KimiK3TextSegment[] {
  return [
    ...openTag('message', [['role', role]]),
    ...text(content),
    ...closeTag('message'),
    ...control('<|end_of_msg|>'),
  ];
}

function renderMessage(message: CompleteInputMessage): readonly KimiK3TextSegment[] {
  const role = message.role as string;
  if (role !== 'system' && role !== 'user' && role !== 'assistant') {
    unsupported(`role:${role}`);
  }
  if (typeof message.content !== 'string') unsupported('non_text_content');
  return renderTextMessage(role, message.content);
}

function renderKimiK3TextOnly(input: CompleteInput): readonly KimiK3TextSegment[] {
  if (input.tools?.length) unsupported('tools');
  if (!Array.isArray(input.messages)) unsupported('messages_not_array');
  if (input.system !== undefined && typeof input.system !== 'string') {
    unsupported('non_text_system');
  }
  if (input.system !== undefined && input.messages.some(message => message.role === 'system')) {
    unsupported('duplicate_system');
  }
  return [
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
  if (error instanceof KimiK3TextEstimateUnsupported) return error.reason;
  return `encoding_failed:${error instanceof Error ? error.name : 'UnknownError'}`;
}

function defaultEncoderFactory(): KimiK3Encoder {
  return new Tiktoken(kimiK3Bpe as TiktokenBPE);
}

/** Local text-only estimate; never a provider usage or final-wire count. */
export function createKimiK3TextMeter(
  descriptor: Readonly<InputMeterDescriptor>,
  encoderFactory: KimiK3EncoderFactory = defaultEncoderFactory,
): ModelInputMeter {
  const cache = new Map<string, number>();
  let cacheBytes = 0;
  let encoder: KimiK3Encoder | undefined;
  let assetError: unknown;

  function getEncoder(): KimiK3Encoder {
    if (assetError !== undefined) throw new KimiK3TextEstimateUnsupported('asset_initialization_failed');
    if (!encoder) {
      try {
        const candidate = encoderFactory();
        for (const token of CONTROL_TOKENS) {
          if (candidate.encode(token, [token], []).length !== 1) {
            throw new Error(`Invalid K3 control token: ${token}`);
          }
        }
        encoder = candidate;
      } catch (error) {
        // silent: retained as meter-local state and exposed as typed unavailable on every measure.
        assetError = error;
        throw new KimiK3TextEstimateUnsupported('asset_initialization_failed');
      }
    }
    return encoder;
  }

  function countText(textValue: string): number {
    const controlInText = CONTROL_TOKENS.find(token => textValue.includes(token));
    if (controlInText) unsupported(`control_token_in_text:${controlInText}`);
    if (!textValue) return 0;
    const key = `${KIMI_K3_TEXT_ASSET_REVISION}\0${KIMI_K3_TEXT_PROJECTION_REVISION}\0${textValue}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const activeEncoder = getEncoder();
    let count = 0;
    for (const chunk of textChunks(textValue)) {
      count += activeEncoder.encode(chunk, [], [...CONTROL_TOKENS]).length;
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

  function countSegment(segment: KimiK3TextSegment): number {
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
        const tokens = renderKimiK3TextOnly(input)
          .reduce((sum, segment) => sum + countSegment(segment), 0);
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

const KIMI_K3_IDENTITIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'kimi-coding': Object.freeze(['k3', 'k3-256k']),
  moonshotai: Object.freeze(['kimi-k3']),
  'moonshotai-cn': Object.freeze(['kimi-k3']),
});

/** Exact catalog identity and OpenAI wire required; display names never qualify. */
export const kimiK3TextInputProfile = Object.freeze({
  id: KIMI_K3_TEXT_PROFILE_ID,
  matches(model: PiAi.Model<PiAi.Api>, resolution: CatalogResolution): boolean {
    return (resolution.kind === 'catalog_model' || resolution.kind === 'metadata_only')
      && resolution.revision === CATALOG_REVISION
      && resolution.providerId !== undefined
      && KIMI_K3_IDENTITIES[resolution.providerId]?.includes(resolution.modelId) === true
      && model.id === resolution.modelId
      && String(model.api) === 'openai-completions'
      && resolution.wire.model === model.id
      && resolution.wire.api === String(model.api);
  },
  descriptor(): MeterQualification {
    return {
      kind: 'estimated',
      method: KIMI_K3_TEXT_METHOD,
      projection: KIMI_K3_TEXT_PROJECTION_REVISION,
      assetRevision: KIMI_K3_TEXT_ASSET_REVISION,
      reason: TEXT_ESTIMATE_REASON,
      limits: Object.freeze({ supportedTools: 'none' }),
    };
  },
  create(input: {
    readonly descriptor: Readonly<InputMeterDescriptor>;
    readonly config: ProviderConfig;
    readonly model: PiAi.Model<PiAi.Api>;
  }): ModelInputMeter {
    return createKimiK3TextMeter(input.descriptor);
  },
});
