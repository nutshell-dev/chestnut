/**
 * @module L4.LLMConfiguration
 *
 * LLM 有效配置、身份与凭据业务的单一入口。
 */
export type {
  CredentialSource,
  ResolvedCredential,
  CredentialInfo,
  CredentialsOwner,
} from './legacy-credentials/index.js';
export { isCredentialRefName } from './legacy-credentials/index.js';
export { CredentialsError, isCredentialsError } from './legacy-credentials/index.js';
export type { CredentialsErrorCode } from './legacy-credentials/index.js';
export {
  getCredentialsHome,
  getCredentialsFilePath,
  getUserDotEnvPath,
  getProjectDotEnvPath,
} from './legacy-credentials/index.js';
export { createLocalCredentials, parseDotEnv } from './legacy-credentials/index.js';
export type { LocalCredentialsDeps } from './legacy-credentials/index.js';
export { createLegacyAuthenticationStore } from './authentication-store.js';
