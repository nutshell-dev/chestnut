/**
 * @module L4.LLMConfiguration.ProviderRepair
 *
 * Resolve exactly one raw provider/draft for probe or in-place repair. Other
 * providers are never read through the credential resolver.
 */
import { sha256Hex } from '../../foundation/node-utils/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js';
import { createAuthenticationCapability } from './authentication-store.js';
import { LLMConfigurationCredentialUnavailableError } from './credential-errors.js';
import { snapshotLLMConfigInput, type LLMConfigSnapshot } from './identity.js';
import {
  createLocalCredentials,
  type CredentialFact,
  type CredentialSource,
} from './legacy-credentials/index.js';
import type { LLMProviderSlot, SharedLLMInput } from './selection.js';

export { LLMConfigurationCredentialUnavailableError } from './credential-errors.js';

type LLMRepairDocument = SharedLLMInput & { readonly revision: number };

const { llmProviderConfigSchema } = llmProviderConfigContract;

export interface LLMProviderSnapshot {
  readonly provider: SharedLLMInput['primary'];
  readonly snapshot: LLMConfigSnapshot;
}

export function providerAtLLMSlot(
  document: LLMRepairDocument,
  slot: LLMProviderSlot,
): SharedLLMInput['primary'] {
  const provider = slot.role === 'primary' ? document.primary : document.fallbacks?.[slot.index];
  if (provider === undefined) {
    const target = slot.role === 'primary' ? 'primary' : `fallback[${slot.index}]`;
    throw new Error(`LLM provider target is unavailable: ${target}`);
  }
  return provider;
}

/** Resolve all reference-bearing fields in one provider, including extra headers. */
export function snapshotLLMProviderDraft(
  deps: { fsFactory(baseDir: string): FileSystem },
  provider: SharedLLMInput['primary'],
  options: {
    timeoutMs?: number;
    revision?: { readonly id: string; readonly revision: number };
    documentSource?: 'document' | 'draft';
  } = {},
): LLMProviderSnapshot {
  // Validate the raw target without using its defaulted output as the persisted raw value.
  llmProviderConfigSchema.parse(provider);
  const credentials = createLocalCredentials({ fsFactory: deps.fsFactory });
  const hits = new Map<string, ReturnType<typeof credentials.resolve>>();
  const credentialSources: Record<string, CredentialSource> = {};
  const credentialFacts: Record<string, CredentialFact> = {};
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\$\{([^}]+)\}/g, (_match, ref: string) => {
        if (!hits.has(ref)) hits.set(ref, credentials.resolve(ref));
        const hit = hits.get(ref);
        if (hit === undefined) throw new LLMConfigurationCredentialUnavailableError(ref);
        credentialSources[ref] = hit.source;
        credentialFacts[ref] = {
          source: hit.source,
          revision: sha256Hex(`${hit.source}\0${hit.value}`),
          identityRef: ref,
        };
        return hit.value;
      });
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    }
    return value;
  };
  const expanded = resolve(provider) as SharedLLMInput['primary'];
  const resolvedProvider = llmProviderConfigSchema.parse({
    ...expanded,
    ...(options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
  });
  const circuitBreaker = { failure_threshold: 3, reset_timeout_ms: 60_000 } as const;
  const snapshot = snapshotLLMConfigInput(
    { llm: { primary: provider, circuit_breaker: circuitBreaker } },
    {
      resolvedInput: { llm: { primary: resolvedProvider, circuit_breaker: circuitBreaker } },
      credentials: createAuthenticationCapability(deps),
      credentialSources,
      credentialFacts,
      ...(options.revision !== undefined ? { revision: options.revision } : {}),
      ...(options.documentSource !== undefined ? { documentSource: options.documentSource } : {}),
    },
  );
  return { provider, snapshot };
}

export function snapshotLLMProviderTarget(
  deps: { fsFactory(baseDir: string): FileSystem },
  document: LLMRepairDocument,
  slot: LLMProviderSlot,
): LLMProviderSnapshot {
  return snapshotLLMProviderDraft(deps, providerAtLLMSlot(document, slot), {
    revision: { id: String(document.revision), revision: document.revision },
    documentSource: 'document',
  });
}
