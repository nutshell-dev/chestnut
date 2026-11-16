/**
 * @module L4.LLMConfiguration.AuthenticationStore
 *
 * 固定绑定兼容用户级 Credentials owner 与 L1 pi-ai CredentialStore。
 * backend 在 store 生命周期内不漂移；modify 完整复用 owner 的跨进程锁事务。
 */
import { llmProviderCredentialRuntime } from '../../foundation/llm-provider/index.js';
const { createPiAiCredentialStore } = llmProviderCredentialRuntime;
type PiAiCredentialBackend = llmProviderCredentialRuntime.PiAiCredentialBackend;
type PiAiCredentialStore = llmProviderCredentialRuntime.PiAiCredentialStore;
import { createLocalCredentials, type LocalCredentialsDeps } from './legacy-credentials/index.js';

/** 创建使用既有用户级存储格式与锁域的 pi-ai CredentialStore。 */
export function createLegacyAuthenticationStore(deps: LocalCredentialsDeps): PiAiCredentialStore {
  const credentials = createLocalCredentials(deps);
  const backend: PiAiCredentialBackend = {
    read: (ref) => Promise.resolve(credentials.resolve(ref)?.value),
    modify: (ref, fn) => credentials.modify(ref, fn),
  };
  return createPiAiCredentialStore(backend);
}
