import type { SharedLLMInput } from '../../core/llm-configuration/index.js';
import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js';
import { sha256Hex } from '../../foundation/node-utils/index.js';

type LLMProviderConfig = SharedLLMInput['primary'];
type ProviderReferenceConfig = { llm: SharedLLMInput; revision?: { readonly id: string } };
const { PROVIDER_NO_LABEL_SENTINEL } = llmProviderConfigContract;

export type ProviderRole = 'primary' | 'fallback';
export type ProviderMatchSource = 'label' | 'preset' | 'provider_id';

/** Non-secret identity facts used for diagnostics and actual-target output. */
export interface ProviderCandidate {
  role: ProviderRole;
  index: number;
  label?: string;
  preset?: string;
  provider_id?: string;
  base_url?: string;
  model?: string;
}

export interface ResolvedProviderReference {
  kind: 'resolved';
  candidate: ProviderCandidate;
  matchedBy: ProviderMatchSource;
}

export type ProviderReferenceResolution =
  | ResolvedProviderReference
  | { kind: 'not_found' }
  | {
    kind: 'ambiguous_provider_reference';
    reference: string;
    candidates: readonly ProviderCandidate[];
  };

function candidate(
  role: ProviderRole,
  index: number,
  entry: LLMProviderConfig,
): ProviderCandidate {
  return {
    role,
    index,
    ...(entry.label !== undefined ? { label: entry.label } : {}),
    ...(entry.provider_id !== undefined ? { provider_id: entry.provider_id } : {}),
    ...(entry.base_url !== undefined ? { base_url: summarizeProviderBaseUrl(entry.base_url) } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
  };
}

/** Primary first, then fallback order: stable and independent of object key order. */
function candidates(config: ProviderReferenceConfig): ProviderCandidate[] {
  return [
    candidate('primary', -1, config.llm.primary),
    ...(config.llm.fallbacks ?? []).map((entry, index) => candidate('fallback', index, entry)),
  ];
}

function resolved(
  hit: ProviderCandidate,
  matchedBy: ProviderMatchSource,
): ResolvedProviderReference {
  return { kind: 'resolved', candidate: hit, matchedBy };
}

/**
 * Resolve a user reference without guessing between multiple compatibility hits.
 * Exact labels are authoritative; preset/provider_id are unique-only fallbacks.
 */
export function resolveProviderReference(
  config: ProviderReferenceConfig,
  reference: string,
): ProviderReferenceResolution {
  const all = candidates(config);
  const labelHits = all.filter(hit => hit.label === reference);
  if (labelHits.length === 1) return resolved(labelHits[0], 'label');
  if (labelHits.length > 1) {
    return { kind: 'ambiguous_provider_reference', reference, candidates: labelHits };
  }

  const compatibilityHits = all.filter(
    hit => hit.preset === reference || hit.provider_id === reference,
  );
  if (compatibilityHits.length === 1) {
    const hit = compatibilityHits[0];
    return resolved(hit, hit.preset === reference ? 'preset' : 'provider_id');
  }
  if (compatibilityHits.length > 1) {
    return { kind: 'ambiguous_provider_reference', reference, candidates: compatibilityHits };
  }
  return { kind: 'not_found' };
}

/** Add deduplication is label-only; a new label may legally equal another preset. */
export function providerLabelExists(config: ProviderReferenceConfig, label: string): boolean {
  return candidates(config).some(hit => hit.label === label);
}

export function providerEntryFor(
  config: ProviderReferenceConfig,
  hit: ProviderCandidate,
): LLMProviderConfig {
  return hit.role === 'primary'
    ? config.llm.primary
    : config.llm.fallbacks![hit.index];
}

export function summarizeProviderBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[redacted]';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // silent: invalid URLs fail closed to a redacted diagnostic instead of echoing input.
    return '[redacted]';
  }
}

export interface ProviderCandidateFacts {
  role: ProviderRole;
  index: number;
  label: string;
  label_state: 'missing' | 'present';
  preset: string;
  provider_id: string;
  base_url: string;
  model: string;
}

/** Shared terminal/audit projection: no credentials, userinfo, query or fragment. */
export function providerCandidateFacts(hit: ProviderCandidate): ProviderCandidateFacts {
  return {
    role: hit.role,
    index: hit.index,
    label: hit.label ?? PROVIDER_NO_LABEL_SENTINEL,
    label_state: hit.label === undefined ? 'missing' : 'present',
    preset: hit.preset ?? '-',
    provider_id: hit.provider_id ?? '-',
    base_url: hit.base_url === undefined ? '-' : summarizeProviderBaseUrl(hit.base_url),
    model: hit.model ?? '-',
  };
}

export function providerAmbiguityMatchSource(
  resolution: Extract<ProviderReferenceResolution, { kind: 'ambiguous_provider_reference' }>,
): ProviderMatchSource | 'mixed' {
  if (resolution.candidates.every(hit => hit.label === resolution.reference)) return 'label';
  const sources = new Set<ProviderMatchSource>(resolution.candidates.map(
    hit => hit.preset === resolution.reference ? 'preset' : 'provider_id',
  ));
  return sources.size === 1 ? [...sources][0] : 'mixed';
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().flatMap(key => {
      const item = record[key];
      return item === undefined ? [] : [`${JSON.stringify(key)}:${stableValue(item)}`];
    }).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Stable identity digest for lock replay; secrets may be hashed but never exposed. */
export function providerTargetFingerprint(
  config: ProviderReferenceConfig,
  hit: ResolvedProviderReference,
): string {
  // Raw lock replay omits schema defaults while loadGlobal resolves credential refs.
  // Normalize defaults, then exclude credentials; config revision owns credential edits.
  const normalized = llmProviderConfigContract.llmProviderConfigSchema.parse(
    providerEntryFor(config, hit.candidate),
  );
  const { api_key: _apiKey, ...nonSecretEntry } = normalized;
  return sha256Hex(stableValue({
    role: hit.candidate.role,
    matchedBy: hit.matchedBy,
    entry: nonSecretEntry,
  }));
}

export function formatProviderTarget(hit: ResolvedProviderReference): string {
  const target = providerCandidateFacts(hit.candidate);
  return `label=${JSON.stringify(target.label)} label_state=${target.label_state} role=${target.role} match=${hit.matchedBy}`;
}

function formatCandidate(hit: ProviderCandidate): string {
  const facts = providerCandidateFacts(hit);
  return [
    `role=${facts.role}`,
    `index=${facts.index}`,
    `label=${JSON.stringify(facts.label)}`,
    `label_state=${facts.label_state}`,
    `preset=${JSON.stringify(facts.preset)}`,
    `provider_id=${JSON.stringify(facts.provider_id)}`,
    `base_url=${JSON.stringify(facts.base_url)}`,
    `model=${JSON.stringify(facts.model)}`,
  ].join(' ');
}

export function formatAmbiguousProviderReference(
  resolution: Extract<ProviderReferenceResolution, { kind: 'ambiguous_provider_reference' }>,
): string {
  const lines = resolution.candidates.map(hit => `  - ${formatCandidate(hit)}`);
  return [
    `Ambiguous provider reference ${JSON.stringify(resolution.reference)} (ambiguous_provider_reference); provider mutation was not applied.`,
    'Candidates:',
    ...lines,
    'Use an exact unique label.',
  ].join('\n');
}
