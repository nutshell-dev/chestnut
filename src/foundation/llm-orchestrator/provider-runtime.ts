/** Provider handle construction, SDK cache and resource lifetime owner. */
import type { llmProviderCall } from '../llm-provider/index.js';
type LLMProvider = llmProviderCall.LLMProvider;
type ProviderDescriptor = llmProviderCall.ProviderDescriptor;
type ProviderFactory = llmProviderCall.ProviderFactory;
type ProviderHandle = llmProviderCall.ProviderHandle;
type ProviderInput = llmProviderCall.ProviderInput;
type ProviderCallDefaults = llmProviderCall.ProviderCallDefaults;
import type {
  ConfiguredProviderCandidate,
  LLMEventSink,
  LLMInstanceLifecycle,
  LLMOrchestratorConfig,
  ProviderCandidateConfig,
} from './types.js';
import { legacyProviderIdentity, providerCacheKey, providerIdentity } from './provider-identity.js';
import { sha256Hex } from '../node-utils/index.js';

function candidateInput(candidate: ProviderCandidateConfig): ProviderInput {
  return 'input' in candidate ? candidate.input : candidate;
}

function candidateCallDefaults(candidate: ProviderCandidateConfig): ProviderCallDefaults {
  return 'input' in candidate ? candidate.callDefaults : {};
}

function normalizeCandidate(candidate: ProviderCandidateConfig): ConfiguredProviderCandidate {
  return {
    ...('input' in candidate && candidate.entryId !== undefined ? { entryId: candidate.entryId } : {}),
    input: candidateInput(candidate),
    callDefaults: candidateCallDefaults(candidate),
    ...('input' in candidate && candidate.displayName !== undefined
      ? { displayName: candidate.displayName }
      : {}),
  };
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

/**
 * Per-entry execution version. Authentication is already represented by L1's
 * opaque operational identity; entry IDs, labels and document revisions are not.
 */
function providerCandidateOperationalIdentity(
  candidate: ConfiguredProviderCandidate,
  descriptor: ProviderDescriptor,
): string {
  return sha256Hex(stableStringify({
    input: providerCacheKey(descriptor),
    callDefaults: candidate.callDefaults,
  }));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function providerIdsFor(
  candidates: readonly ConfiguredProviderCandidate[],
  mode: LLMInstanceLifecycle['mode'],
): string[] {
  const seen = new Set<string>();
  return candidates.map((candidate, index) => {
    const entryId = candidate.entryId;
    if (mode === 'durable' && entryId === undefined) throw new Error('Missing persisted LLM entry ID');
    if (entryId !== undefined && !UUID_PATTERN.test(entryId)) throw new Error('Invalid persisted LLM entry ID');
    const id = entryId !== undefined ? `entry:${entryId}` : `ephemeral:${index}`;
    if (seen.has(id)) throw new Error(`Duplicate LLM entry ID: ${entryId ?? id}`);
    seen.add(id);
    return id;
  });
}

export interface PreparedProviderReload {
  readonly config: LLMOrchestratorConfig;
  readonly primary: LLMProvider;
  readonly fallbacks: readonly LLMProvider[];
  readonly descriptors: readonly ProviderDescriptor[];
  readonly candidates: readonly ConfiguredProviderCandidate[];
  readonly providerIds: readonly string[];
  readonly operationalIdentities: readonly string[];
  readonly connectionProviderIds: readonly string[];
  readonly legacyProviderIds: readonly string[];
  readonly oldKeys: ReadonlySet<string>;
}

export interface ProviderRuntime {
  primary(): LLMProvider;
  fallbacks(): readonly LLMProvider[];
  descriptors(): readonly ProviderDescriptor[];
  /** Candidate position disambiguates multiple entries sharing one SDK adapter. */
  callDefaults?(adapter: LLMProvider, candidateIndex: number): ProviderCallDefaults;
  displayName?(adapter: LLMProvider, candidateIndex: number): string;
  config(): LLMOrchestratorConfig;
  providerIds(): readonly string[];
  operationalIdentities(): readonly string[];
  /** Previous descriptor.identity values; only legacy state conversion/diagnostics may consume them. */
  connectionProviderIds(): readonly string[];
  legacyProviderIds(): readonly string[];
  configGeneration(): number;
  prepareReload(config: LLMOrchestratorConfig): PreparedProviderReload;
  commitReload(prepared: PreparedProviderReload): void;
  close(): Promise<void>;
}

export class LLMProviderRuntime implements ProviderRuntime {
  private readonly events: LLMEventSink;
  private readonly providerFactory: ProviderFactory;
  private readonly lifecycleMode: LLMInstanceLifecycle['mode'];
  private readonly sdkClientCache = new Map<string, ProviderHandle>();
  private pendingClose: LLMProvider[] = [];
  private activeConfig: LLMOrchestratorConfig;
  private activePrimary: LLMProvider;
  private activeFallbacks: LLMProvider[];
  private activeDescriptors: readonly ProviderDescriptor[];
  private activeCandidates: readonly ConfiguredProviderCandidate[];
  private activeProviderIds: readonly string[];
  private activeOperationalIdentities: readonly string[];
  private activeConnectionProviderIds: readonly string[];
  private activeLegacyProviderIds: readonly string[];
  private activeConfigGeneration = 0;
  private closed = false;

  constructor(config: LLMOrchestratorConfig) {
    this.events = config.events;
    this.providerFactory = config.providerFactory;
    this.lifecycleMode = config.lifecycle?.mode ?? 'ephemeral';
    this.activeConfig = config;
    this.activeCandidates = [config.primary, ...(config.fallbacks ?? [])].map(normalizeCandidate);
    this.activeProviderIds = providerIdsFor(this.activeCandidates, this.lifecycleMode);
    const handles = this.activeCandidates.map(candidate => this.getSdkClient(candidate));
    this.activeOperationalIdentities = this.activeCandidates.map((candidate, index) =>
      providerCandidateOperationalIdentity(candidate, handles[index]!.descriptor));
    const primary = handles[0]!;
    const fallbacks = handles.slice(1);
    this.activePrimary = primary.provider;
    this.activeFallbacks = fallbacks.map(handle => handle.provider);
    this.activeDescriptors = handles.map(handle => handle.descriptor);
    this.activeConnectionProviderIds = this.activeDescriptors.map(providerIdentity);
    this.activeLegacyProviderIds = this.activeDescriptors.map(legacyProviderIdentity);
  }

  primary(): LLMProvider { return this.activePrimary; }
  fallbacks(): readonly LLMProvider[] { return this.activeFallbacks; }
  descriptors(): readonly ProviderDescriptor[] { return this.activeDescriptors; }

  callDefaults(_adapter: LLMProvider, candidateIndex: number): ProviderCallDefaults {
    return this.activeCandidates[candidateIndex]?.callDefaults ?? {};
  }

  displayName(adapter: LLMProvider, candidateIndex: number): string {
    return this.activeCandidates[candidateIndex]?.displayName ?? adapter.name;
  }

  config(): LLMOrchestratorConfig { return this.activeConfig; }
  providerIds(): readonly string[] { return this.activeProviderIds; }
  operationalIdentities(): readonly string[] { return this.activeOperationalIdentities; }
  connectionProviderIds(): readonly string[] { return this.activeConnectionProviderIds; }
  legacyProviderIds(): readonly string[] { return this.activeLegacyProviderIds; }
  configGeneration(): number { return this.activeConfigGeneration; }

  /** Actual cache reference for runtime lifecycle tests. */
  get clientCache(): Map<string, ProviderHandle> { return this.sdkClientCache; }

  private retireUnused(provider: LLMProvider): void {
    try {
      const result = (provider as { close?: () => Promise<void> | void }).close?.();
      if (result instanceof Promise) {
        void result.catch(error => this.events.emit({ type: 'provider_close_failed', error: String(error) }));
      }
    } catch (error) {
      // silent: close failures are isolated and exposed through provider_close_failed.
      this.events.emit({ type: 'provider_close_failed', error: String(error) });
    }
  }

  private getSdkClient(candidateConfig: ProviderCandidateConfig): ProviderHandle {
    // Only the L1 input reaches the factory; entryId is scheduler metadata.
    const input = candidateInput(candidateConfig);
    const created = this.providerFactory.create(input);
    const key = providerCacheKey(created.descriptor);
    const cached = this.sdkClientCache.get(key);
    if (cached) {
      this.events?.emit({
        type: 'sdk_client_cache_hit',
        protocol: cached.descriptor.protocol || 'unknown',
        model: cached.descriptor.model || 'unknown',
      });
      if (cached.provider !== created.provider) this.retireUnused(created.provider);
      return cached;
    }
    this.sdkClientCache.set(key, created);
    this.events?.emit({
      type: 'sdk_client_cache_miss',
      protocol: created.descriptor.protocol || 'unknown',
      model: created.descriptor.model || 'unknown',
    });
    return created;
  }

  /** Validate entry keys before creating handles; activation waits for the V4 state commit. */
  prepareReload(config: LLMOrchestratorConfig): PreparedProviderReload {
    const candidates = [config.primary, ...(config.fallbacks ?? [])].map(normalizeCandidate);
    const providerIds = providerIdsFor(candidates, this.lifecycleMode);
    const oldKeys = new Set(this.sdkClientCache.keys());
    const handles = candidates.map(candidate => this.getSdkClient(candidate));
    const operationalIdentities = candidates.map((candidate, index) =>
      providerCandidateOperationalIdentity(candidate, handles[index]!.descriptor));
    const primary = handles[0]!;
    const fallbacks = handles.slice(1);
    const descriptors = handles.map(handle => handle.descriptor);
    return {
      config,
      primary: primary.provider,
      fallbacks: fallbacks.map(handle => handle.provider),
      descriptors,
      candidates,
      providerIds,
      operationalIdentities,
      connectionProviderIds: descriptors.map(providerIdentity),
      legacyProviderIds: descriptors.map(legacyProviderIdentity),
      oldKeys,
    };
  }

  /** Activate only after V4 commit; superseded adapters remain open until close. */
  commitReload(prepared: PreparedProviderReload): void {
    this.activeConfig = prepared.config;
    this.activePrimary = prepared.primary;
    this.activeFallbacks = [...prepared.fallbacks];
    this.activeDescriptors = [...prepared.descriptors];
    this.activeCandidates = [...prepared.candidates];
    this.activeProviderIds = [...prepared.providerIds];
    this.activeOperationalIdentities = [...prepared.operationalIdentities];
    this.activeConnectionProviderIds = [...prepared.connectionProviderIds];
    this.activeLegacyProviderIds = [...prepared.legacyProviderIds];
    this.activeConfigGeneration += 1;
    const newProviders = new Set([prepared.primary, ...prepared.fallbacks]);
    for (const key of prepared.oldKeys) {
      const handle = this.sdkClientCache.get(key);
      if (!handle) continue;
      if (!newProviders.has(handle.provider)) {
        this.pendingClose.push(handle.provider);
        this.sdkClientCache.delete(key);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const allToClose = [...new Set([
      ...[...this.sdkClientCache.values()].map(handle => handle.provider),
      ...this.pendingClose,
    ])];
    const results = await Promise.allSettled(allToClose.map(provider => {
      const maybeClose = (provider as { close?: () => Promise<void> | void }).close?.();
      return maybeClose instanceof Promise ? maybeClose : Promise.resolve();
    }));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.events.emit({ type: 'provider_close_failed', error: String(result.reason) });
      }
    }
    this.sdkClientCache.clear();
    this.pendingClose = [];
  }
}
