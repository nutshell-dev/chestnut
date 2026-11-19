/** Explicit credential-store and pi-ai runtime support for auth/assembly paths. */
import type {
  PiAiCredentialBackend,
  PiAiCredentialStore,
} from '../pi-ai-credentials.js';
import type { PiAiRuntime } from '../pi-ai-support.js';
import { createPiAiCredentialStore } from '../pi-ai-credentials.js';

/** setup/assembly 专用：把显式 setup 的 read/modify 组合为固定生命周期 raw store。 */
export function createStore(backend: PiAiCredentialBackend): PiAiCredentialStore {
  return createPiAiCredentialStore(backend);
}

export interface LLMProviderCredentialCapability {
  readonly createStore: (backend: PiAiCredentialBackend) => PiAiCredentialStore;
  readonly credentialRef: (providerOrModel: string) => string;
}

export interface LLMProviderRuntimeCapability {
  readonly loadRuntime: () => Promise<PiAiRuntime>;
}

export { piAiCredentialRef } from '../pi-ai-credentials.js';
export type { PiAiCredentialBackend, PiAiCredentialStore } from '../pi-ai-credentials.js';
export { loadPiAiRuntime } from '../pi-ai-support.js';
export type { PiAiRuntime } from '../pi-ai-support.js';
