/** Explicit credential-store and pi-ai runtime support for auth/assembly paths. */
import type {
  PiAiCredentialBackend,
  PiAiCredentialStore,
} from '../pi-ai-credentials.js';
import type { PiAiRuntime } from '../pi-ai-support.js';

export interface LLMProviderCredentialCapability {
  readonly createStore: (backend: PiAiCredentialBackend) => PiAiCredentialStore;
  readonly credentialRef: (providerOrModel: string) => string;
}

export interface LLMProviderRuntimeCapability {
  readonly loadRuntime: () => Promise<PiAiRuntime>;
}

export {
  createPiAiCredentialStore,
  piAiCredentialRef,
} from '../pi-ai-credentials.js';
export type { PiAiCredentialBackend, PiAiCredentialStore } from '../pi-ai-credentials.js';
export { loadPiAiRuntime } from '../pi-ai-support.js';
export type { PiAiRuntime } from '../pi-ai-support.js';
