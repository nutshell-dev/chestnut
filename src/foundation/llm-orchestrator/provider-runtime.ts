/** Provider handle construction, SDK cache and resource lifetime owner. */
import type { llmProviderCall } from '../llm-provider/index.js';
type LLMProvider = llmProviderCall.LLMProvider;
type ProviderDescriptor = llmProviderCall.ProviderDescriptor;
type ProviderFactory = llmProviderCall.ProviderFactory;
type ProviderHandle = llmProviderCall.ProviderHandle;
type ProviderInput = llmProviderCall.ProviderInput;
import type { LLMEventSink, LLMOrchestratorConfig } from './types.js';
import { legacyProviderIdentity, providerCacheKey, providerIdentity } from './provider-identity.js';

export interface PreparedProviderReload {
  readonly config: LLMOrchestratorConfig;
  readonly primary: LLMProvider;
  readonly fallbacks: readonly LLMProvider[];
  readonly descriptors: readonly ProviderDescriptor[];
  readonly providerIds: readonly string[];
  readonly legacyProviderIds: readonly string[];
  readonly oldKeys: ReadonlySet<string>;
}

export interface ProviderRuntime {
  primary(): LLMProvider;
  fallbacks(): readonly LLMProvider[];
  descriptors(): readonly ProviderDescriptor[];
  config(): LLMOrchestratorConfig;
  providerIds(): readonly string[];
  legacyProviderIds(): readonly string[];
  configGeneration(): number;
  prepareReload(config: LLMOrchestratorConfig): PreparedProviderReload;
  commitReload(prepared: PreparedProviderReload): void;
  close(): Promise<void>;
}

export class LLMProviderRuntime implements ProviderRuntime {
  private readonly events: LLMEventSink;
  private readonly providerFactory: ProviderFactory;
  private readonly sdkClientCache = new Map<string, ProviderHandle>();
  private pendingClose: LLMProvider[] = [];
  private activeConfig: LLMOrchestratorConfig;
  private activePrimary: LLMProvider;
  private activeFallbacks: LLMProvider[];
  private activeDescriptors: readonly ProviderDescriptor[];
  private activeProviderIds: readonly string[];
  private activeLegacyProviderIds: readonly string[];
  private activeConfigGeneration = 0;
  private closed = false;

  constructor(config: LLMOrchestratorConfig) {
    this.events = config.events;
    this.providerFactory = config.providerFactory;
    this.activeConfig = config;
    const primary = this.getSdkClient(config.primary);
    const fallbacks = (config.fallbacks ?? []).map(provider => this.getSdkClient(provider));
    this.activePrimary = primary.provider;
    this.activeFallbacks = fallbacks.map(handle => handle.provider);
    this.activeDescriptors = [primary.descriptor, ...fallbacks.map(handle => handle.descriptor)];
    this.activeProviderIds = this.activeDescriptors.map(providerIdentity);
    this.activeLegacyProviderIds = this.activeDescriptors.map(legacyProviderIdentity);
  }

  primary(): LLMProvider {
    return this.activePrimary;
  }

  fallbacks(): readonly LLMProvider[] {
    return this.activeFallbacks;
  }

  descriptors(): readonly ProviderDescriptor[] {
    return this.activeDescriptors;
  }

  config(): LLMOrchestratorConfig {
    return this.activeConfig;
  }

  providerIds(): readonly string[] {
    return this.activeProviderIds;
  }

  legacyProviderIds(): readonly string[] {
    return this.activeLegacyProviderIds;
  }

  configGeneration(): number {
    return this.activeConfigGeneration;
  }

  /** Actual cache reference for runtime lifecycle tests. */
  get clientCache(): Map<string, ProviderHandle> {
    return this.sdkClientCache;
  }

  private getSdkClient(input: ProviderInput): ProviderHandle {
    const created = this.providerFactory.create(input);
    const key = providerCacheKey(created.descriptor);
    const cached = this.sdkClientCache.get(key);
    if (cached) {
      this.events?.emit({
        type: 'sdk_client_cache_hit',
        preset: cached.descriptor.protocol || 'unknown',
        model: cached.descriptor.model || 'unknown',
      });
      return cached;
    }
    this.sdkClientCache.set(key, created);
    this.events?.emit({
      type: 'sdk_client_cache_miss',
      preset: created.descriptor.protocol || 'unknown',
      model: created.descriptor.model || 'unknown',
    });
    return created;
  }

  /** Create the next handle view before the Facade attempts its V3 commit. */
  prepareReload(config: LLMOrchestratorConfig): PreparedProviderReload {
    const oldKeys = new Set(this.sdkClientCache.keys());
    const primary = this.getSdkClient(config.primary);
    const fallbacks = (config.fallbacks ?? []).map(provider => this.getSdkClient(provider));
    const handles = [primary, ...fallbacks];
    const descriptors = handles.map(handle => handle.descriptor);
    return {
      config,
      primary: primary.provider,
      fallbacks: fallbacks.map(handle => handle.provider),
      descriptors,
      providerIds: descriptors.map(providerIdentity),
      legacyProviderIds: descriptors.map(legacyProviderIdentity),
      oldKeys,
    };
  }

  /** Activate only after V3 commit; superseded adapters remain open until close. */
  commitReload(prepared: PreparedProviderReload): void {
    this.activeConfig = prepared.config;
    this.activePrimary = prepared.primary;
    this.activeFallbacks = [...prepared.fallbacks];
    this.activeDescriptors = [...prepared.descriptors];
    this.activeProviderIds = [...prepared.providerIds];
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
    const allToClose = [
      ...[...this.sdkClientCache.values()].map(handle => handle.provider),
      ...this.pendingClose,
    ];
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
