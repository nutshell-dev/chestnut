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
export { resolveLLMConfig } from './selection.js';
export type {
  LLMGlobalConfigView,
  LLMClawConfigView,
  LLMConfigInput,
  SharedLLM,
  SharedLLMInput,
} from './selection.js';
export {
  snapshotLLMConfig,
  snapshotLLMConfigInput,
  llmConfigIdentity,
  LLMConfigIdentityMismatchError,
} from './identity.js';
export type { LLMConfigSnapshot } from './identity.js';
export {
  isCredentialReference,
  deriveCredentialRef,
  storeCredentialInput,
  resolveCredentialReference,
} from './key-input.js';
export type { StoredCredentialInput } from './key-input.js';
export {
  createLLMConfiguration,
  createLLMConfigurationDocumentStore,
  getLLMConfigurationPath,
  llmConfigurationSourceDigest,
  newLLMMigrationId,
  readLLMMigrationRecord,
  recordLLMMigrationSourceCleanup,
  recordLLMMigrationSourceCleanupFailure,
  LLMConfigurationNotFoundError,
  LLMConfigurationMigrationError,
} from './document-store.js';
export {
  createLLMApplicationStore,
  createLLMNotificationStore,
} from './propagation-store.js';
export type {
  LLMApplicationFact,
  LLMApplicationStore,
  RecordLLMApplicationInput,
  LLMNotificationFact,
  LLMNotificationStore,
} from './propagation-store.js';
export type {
  LLMConfigDocument,
  ResolvedLLMConfigDocument,
  LLMConfigurationAdmin,
  LLMConfigurationDocumentStore,
  LLMConfigurationRevision,
  LLMConfigurationWriteResult,
} from './document-store.js';
