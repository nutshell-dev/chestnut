import { describe, expect, it } from 'vitest';
import type { LLMGlobalConfigView } from '../../src/core/llm-configuration/index.js';
import {
  llmProviderConfigSchema,
  PROVIDER_NO_LABEL_SENTINEL,
  type LLMProviderConfig,
} from '../../src/foundation/llm-provider/llm-provider-config-schema.js';
import {
  formatAmbiguousProviderReference,
  formatProviderTarget,
  providerLabelExists,
  providerTargetFingerprint,
  resolveProviderReference,
  summarizeProviderBaseUrl,
} from '../../src/cli/commands/provider-reference.js';

function entry(input: Partial<LLMProviderConfig>): LLMProviderConfig {
  return {
    provider_id: 'custom:provider',
    api_format: 'openai',
    auth_profile: 'ambient',
    model: 'model',
    base_url: 'https://provider.test',
    temperature: 0.7,
    timeout_ms: 30_000,
    ...input,
  };
}

function config(
  primary: Partial<LLMProviderConfig>,
  fallbacks: Array<Partial<LLMProviderConfig>> = [],
): LLMGlobalConfigView {
  return { llm: { primary: entry(primary), fallbacks: fallbacks.map(entry) } };
}

type LegacyProviderInput = Partial<LLMProviderConfig> & { preset?: string };

/** Test-only raw compatibility input; persisted normal configuration is explicit. */
function legacyConfig(
  primary: LegacyProviderInput,
  fallbacks: LegacyProviderInput[] = [],
): LLMGlobalConfigView {
  return { llm: { primary, fallbacks } } as unknown as LLMGlobalConfigView;
}

describe('provider reference resolution', () => {
  it('prefers a fallback exact label over primary and fallback provider_id collisions', () => {
    const result = resolveProviderReference(config(
      { provider_id: 'shared', label: 'primary-label' },
      [
        { provider_id: 'other', label: 'shared' },
        { provider_id: 'shared', label: 'other-label' },
      ],
    ), 'shared');

    expect(result).toMatchObject({
      kind: 'resolved',
      matchedBy: 'label',
      candidate: { role: 'fallback', index: 0, label: 'shared', provider_id: 'other' },
    });
  });

  it('allows a unique provider_id hit without inventing a label', () => {
    const result = resolveProviderReference(config(
      { provider_id: 'anthropic', label: 'main' },
      [{ provider_id: 'openai', model: 'gpt-test' }],
    ), 'openai');

    expect(result).toMatchObject({
      kind: 'resolved',
      matchedBy: 'provider_id',
      candidate: { role: 'fallback', index: 0, model: 'gpt-test', provider_id: 'openai' },
    });
    if (result.kind === 'resolved') {
      expect(result.candidate.label).toBeUndefined();
      expect(formatProviderTarget(result)).toBe(
        'Fallback #1 (no label)',
      );
    }
  });

  it('allows a unique provider_id compatibility hit', () => {
    const result = resolveProviderReference(config(
      { label: 'main' },
      [{ provider_id: 'catalog-provider', label: 'catalog' }],
    ), 'catalog-provider');

    expect(result).toMatchObject({
      kind: 'resolved',
      matchedBy: 'provider_id',
      candidate: { role: 'fallback', index: 0, provider_id: 'catalog-provider' },
    });
  });

  it('rejects shared provider_id hits and lists candidates in primary/fallback order', () => {
    const result = resolveProviderReference(config(
      { provider_id: 'shared', label: 'primary-label', base_url: 'https://primary.test' },
      [
        { provider_id: 'shared', label: 'one', model: 'model-one' },
        { provider_id: 'shared', model: 'model-two' },
      ],
    ), 'shared');

    expect(result).toMatchObject({
      kind: 'ambiguous_provider_reference',
      reference: 'shared',
      candidates: [
        { role: 'primary', index: -1, label: 'primary-label' },
        { role: 'fallback', index: 0, label: 'one' },
        { role: 'fallback', index: 1, model: 'model-two', provider_id: 'shared' },
      ],
    });
    if (result.kind !== 'ambiguous_provider_reference') throw new Error('expected ambiguity');
    const message = formatAmbiguousProviderReference(result);
    expect(message).toContain('ambiguous_provider_reference');
    expect(message).toContain('role=primary index=-1');
    expect(message).toContain('base_url="https://primary.test/"');
    expect(message).toContain('label="(no label)" label_state=missing');
    expect(message.indexOf('role=primary')).toBeLessThan(message.indexOf('role=fallback'));
  });

  it('rejects duplicate exact labels rather than choosing the first', () => {
    const result = resolveProviderReference(config(
      { label: 'duplicate' },
      [{ label: 'duplicate' }],
    ), 'duplicate');

    expect(result).toMatchObject({
      kind: 'ambiguous_provider_reference',
      candidates: [
        { role: 'primary', index: -1 },
        { role: 'fallback', index: 0 },
      ],
    });
  });

  it('changes the target fingerprint when a same-label reference resolves to a replacement entry', () => {
    const before = config({}, [{ label: 'target', provider_id: 'old', model: 'old-model' }]);
    const after = config({}, [{ label: 'target', provider_id: 'new', model: 'new-model' }]);
    const beforeHit = resolveProviderReference(before, 'target');
    const afterHit = resolveProviderReference(after, 'target');
    if (beforeHit.kind !== 'resolved' || afterHit.kind !== 'resolved') throw new Error('expected resolved targets');

    expect(providerTargetFingerprint(before, beforeHit))
      .not.toBe(providerTargetFingerprint(after, afterHit));
    expect(providerTargetFingerprint(before, beforeHit))
      .toBe(providerTargetFingerprint(before, beforeHit));
  });

  it('preserves not-found classification', () => {
    expect(resolveProviderReference(config({}), 'missing'))
      .toEqual({ kind: 'not_found' });
  });

  it('redacts userinfo, query and fragment from candidate URLs and diagnostics', () => {
    const secretUrl = 'https://user:password@provider.test/v1?token=query-secret&signature=signed#fragment-secret';
    const result = resolveProviderReference(config(
      { provider_id: 'shared', base_url: secretUrl },
      [{ provider_id: 'shared', base_url: secretUrl }],
    ), 'shared');

    expect(JSON.stringify(result)).not.toContain('user:password');
    expect(JSON.stringify(result)).not.toContain('query-secret');
    expect(JSON.stringify(result)).not.toContain('signed');
    expect(JSON.stringify(result)).not.toContain('fragment-secret');
    if (result.kind !== 'ambiguous_provider_reference') throw new Error('expected ambiguity');
    const message = formatAmbiguousProviderReference(result);
    expect(message).toContain('base_url="https://provider.test/v1"');
    expect(message).not.toContain('user:password');
    expect(message).not.toContain('query-secret');
    expect(message).not.toContain('fragment-secret');
  });

  it.each([
    'data:text/plain,dummy-data-secret',
    'mailto:dummy-mail-secret@example.test',
    'not a URL containing dummy-parse-secret',
  ])('redacts unsupported or invalid URL %s from helper, candidates and diagnostics', (rawUrl) => {
    expect(summarizeProviderBaseUrl(rawUrl)).toBe('[redacted]');
    const result = resolveProviderReference(config(
      { provider_id: 'shared', base_url: rawUrl },
      [{ provider_id: 'shared', base_url: rawUrl }],
    ), 'shared');

    expect(JSON.stringify(result)).not.toContain('dummy-');
    expect(JSON.stringify(result)).toContain('[redacted]');
    if (result.kind !== 'ambiguous_provider_reference') throw new Error('expected ambiguity');
    const message = formatAmbiguousProviderReference(result);
    expect(message).toContain('base_url="[redacted]"');
    expect(message).not.toContain('dummy-');
  });

  it('distinguishes missing labels from a raw sentinel-shaped label in diagnostics', () => {
    const missing = resolveProviderReference(config({ label: undefined }), 'custom:provider');
    const present = resolveProviderReference(config({}, [{ label: PROVIDER_NO_LABEL_SENTINEL }]), PROVIDER_NO_LABEL_SENTINEL);
    if (missing.kind !== 'resolved' || present.kind !== 'resolved') throw new Error('expected resolved targets');

    expect(formatProviderTarget(missing)).toBe('Primary (no label)');
    expect(formatProviderTarget(present)).toBe('Fallback #1 "(no label)"');
    expect(() => llmProviderConfigSchema.parse(entry({ label: PROVIDER_NO_LABEL_SENTINEL })))
      .toThrow(/reserved no-label sentinel/);
  });

  it('does not include credentials in candidates or diagnostics', () => {
    const result = resolveProviderReference(config(
      { provider_id: 'shared', api_key: 'secret-primary' },
      [{ provider_id: 'shared', api_key: 'secret-fallback' }],
    ), 'shared');

    expect(JSON.stringify(result)).not.toContain('secret-primary');
    expect(JSON.stringify(result)).not.toContain('secret-fallback');
    expect(result.kind === 'ambiguous_provider_reference' && 'api_key' in result.candidates[0])
      .toBe(false);
  });
});

describe('provider add label deduplication', () => {
  const existing = config(
    { label: 'main' },
    [{ provider_id: 'catalog-provider', label: 'catalog' }],
  );
  const legacyExisting = legacyConfig({ preset: 'anthropic', label: 'main' });

  it('detects actual labels in primary and fallback entries', () => {
    expect(providerLabelExists(existing, 'main')).toBe(true);
    expect(providerLabelExists(existing, 'catalog')).toBe(true);
  });

  it('does not treat another entry preset or provider_id as a duplicate label', () => {
    expect(providerLabelExists(legacyExisting, 'anthropic')).toBe(false);
    expect(providerLabelExists(existing, 'catalog-provider')).toBe(false);
  });
});
