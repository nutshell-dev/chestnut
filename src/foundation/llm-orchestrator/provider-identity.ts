/**
 * L2 consumes opaque, secret-safe identities from L1 descriptors. It never
 * reconstructs identity from authentication, catalog or connection fields.
 */
import type { llmProviderCall } from '../llm-provider/index.js';
type ProviderDescriptor = llmProviderCall.ProviderDescriptor;

/** Legacy identity supplied by L1 solely for persisted recovery migration. */
export function legacyProviderIdentity(descriptor: ProviderDescriptor): string {
  return descriptor.legacyIdentity;
}

/** Fault/recovery ownership identity supplied by L1. */
export function providerIdentity(descriptor: ProviderDescriptor): string {
  return descriptor.identity;
}

/** Behavior-aware adapter reuse identity supplied by L1. */
export function providerCacheKey(descriptor: ProviderDescriptor): string {
  return descriptor.cacheKey;
}
