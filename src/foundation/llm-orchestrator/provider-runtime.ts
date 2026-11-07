/** Provider adapter construction, SDK cache and resource lifetime owner. */
import {
  createLLMProvider,
  type AuditSink,
  type LLMProvider,
  type PiAiCredentialStore,
  type ProviderAdapter,
  type ProviderConfig,
} from '../llm-provider/index.js';
import type { LLMEventSink, LLMOrchestratorConfig } from './types.js';
import { providerCacheKey } from './provider-identity.js';

export interface PreparedProviderReload {
  readonly primary: LLMProvider;
  readonly fallbacks: readonly LLMProvider[];
  readonly oldKeys: ReadonlySet<string>;
}

export interface ProviderRuntime {
  primary(): LLMProvider;
  fallbacks(): readonly LLMProvider[];
  prepareReload(config: LLMOrchestratorConfig): PreparedProviderReload;
  commitReload(prepared: PreparedProviderReload): void;
  close(): Promise<void>;
}

export class LLMProviderRuntime implements ProviderRuntime {
  private readonly events: LLMEventSink;
  private readonly createProviderAdapter: ((config: ProviderConfig) => ProviderAdapter) | undefined;
  private readonly credentialStore: PiAiCredentialStore | undefined;
  private readonly sdkClientCache = new Map<string, LLMProvider>();
  private readonly auditLogIdMap = new WeakMap<AuditSink, string>();
  private nextAuditLogId = 0;
  private pendingClose: LLMProvider[] = [];
  private activePrimary: LLMProvider;
  private activeFallbacks: LLMProvider[];
  private closed = false;

  constructor(config: LLMOrchestratorConfig) {
    this.events = config.events;
    this.createProviderAdapter = config.createProviderAdapter;
    this.credentialStore = config.credentialStore;
    this.activePrimary = this.getSdkClient(config.primary);
    this.activeFallbacks = (config.fallbacks ?? []).map(provider => this.getSdkClient(provider));
  }

  primary(): LLMProvider {
    return this.activePrimary;
  }

  fallbacks(): readonly LLMProvider[] {
    return this.activeFallbacks;
  }

  /** Actual cache reference for the Facade's legacy white-box compatibility getter. */
  get clientCache(): Map<string, LLMProvider> {
    return this.sdkClientCache;
  }

  private getAuditLogId(auditLog?: AuditSink): string {
    if (!auditLog) return 'absent';
    let id = this.auditLogIdMap.get(auditLog);
    if (!id) {
      id = `audit-${++this.nextAuditLogId}`;
      this.auditLogIdMap.set(auditLog, id);
    }
    return id;
  }

  private getSdkClient(config: ProviderConfig): LLMProvider {
    const key = providerCacheKey(config, this.getAuditLogId(config.auditLog));
    if (!this.sdkClientCache.has(key)) {
      const provider = this.createProviderAdapter
        ? (this.createProviderAdapter(config) as LLMProvider)
        : createLLMProvider(config, { credentialStore: this.credentialStore });
      this.sdkClientCache.set(key, provider);
      this.events?.emit({ type: 'sdk_client_cache_miss', preset: config.apiFormat ?? 'unknown', model: config.model ?? 'unknown' });
    } else {
      this.events?.emit({ type: 'sdk_client_cache_hit', preset: config.apiFormat ?? 'unknown', model: config.model ?? 'unknown' });
    }
    return this.sdkClientCache.get(key)!;
  }

  /** Create the next adapter view before the Facade attempts its V3 commit. */
  prepareReload(config: LLMOrchestratorConfig): PreparedProviderReload {
    const oldKeys = new Set(this.sdkClientCache.keys());
    const primary = this.getSdkClient(config.primary);
    const fallbacks = (config.fallbacks ?? []).map(provider => this.getSdkClient(provider));
    return { primary, fallbacks, oldKeys };
  }

  /** Activate only after V3 commit; superseded adapters remain open until close. */
  commitReload(prepared: PreparedProviderReload): void {
    this.activePrimary = prepared.primary;
    this.activeFallbacks = [...prepared.fallbacks];
    const newProviders = new Set([prepared.primary, ...prepared.fallbacks]);
    for (const key of prepared.oldKeys) {
      const provider = this.sdkClientCache.get(key);
      if (!provider) continue;
      if (!newProviders.has(provider)) {
        this.pendingClose.push(provider);
        this.sdkClientCache.delete(key);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const allToClose = [...this.sdkClientCache.values(), ...this.pendingClose];
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
