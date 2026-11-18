import type { LLMGlobalConfigView } from '../../core/llm-configuration/index.js';
import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js';

type LLMProviderConfig = llmProviderConfigContract.LLMProviderConfig;

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
    ...(entry.preset !== undefined ? { preset: entry.preset } : {}),
    ...(entry.provider_id !== undefined ? { provider_id: entry.provider_id } : {}),
    ...(entry.base_url !== undefined ? { base_url: entry.base_url } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
  };
}

/** Primary first, then fallback order: stable and independent of object key order. */
function candidates(config: LLMGlobalConfigView): ProviderCandidate[] {
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
  config: LLMGlobalConfigView,
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
export function providerLabelExists(config: LLMGlobalConfigView, label: string): boolean {
  return candidates(config).some(hit => hit.label === label);
}

export function providerEntryFor(
  config: LLMGlobalConfigView,
  hit: ProviderCandidate,
): LLMProviderConfig {
  return hit.role === 'primary'
    ? config.llm.primary
    : config.llm.fallbacks![hit.index];
}

export function formatProviderTarget(hit: ResolvedProviderReference): string {
  const target = hit.candidate;
  return `label=${JSON.stringify(target.label || '(no label)')} role=${target.role} match=${hit.matchedBy}`;
}

function formatCandidate(hit: ProviderCandidate): string {
  return [
    `role=${hit.role}`,
    `index=${hit.index}`,
    `label=${JSON.stringify(hit.label || '(no label)')}`,
    `preset=${JSON.stringify(hit.preset ?? '-')}`,
    `provider_id=${JSON.stringify(hit.provider_id ?? '-')}`,
    `base_url=${JSON.stringify(hit.base_url ?? '-')}`,
    `model=${JSON.stringify(hit.model ?? '-')}`,
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
