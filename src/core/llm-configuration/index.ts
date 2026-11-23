/**
 * @module L4.LLMConfiguration
 *
 * LLM 有效配置、身份与凭据业务的单一入口。
 */
export type { CredentialSource, CredentialFact } from './legacy-credentials/index.js';
export { isCredentialRefName } from './legacy-credentials/index.js';
export { CredentialsError, isCredentialsError } from './legacy-credentials/index.js';
export type { CredentialsErrorCode } from './legacy-credentials/index.js';
export { createAuthenticationCapability } from './authentication-store.js';
export type {
  AuthenticationCapabilityDeps,
  ProviderAuthenticationCapability,
  ProviderAuthenticationDescription,
} from './authentication-store.js';
export { llmOrchestratorConfigSchema } from './config-schema.js';
export { resolveLLMConfig } from './selection.js';
export type {
  LLMGlobalConfigView,
  LLMRawConfigView,
  LLMClawConfigView,
  LLMConfigInput,
  LLMResolvedConfiguration,
  SharedLLM,
  SharedLLMInput,
  LLMProviderSlot,
} from './selection.js';
export {
  snapshotLLMConfig,
  snapshotLLMConfigInput,
  llmConfigIdentity,
  LLMConfigIdentityMismatchError,
} from './identity.js';
export type {
  LLMConfigSnapshot,
  LLMConfigScope,
  LLMConfigSnapshotOptions,
  CredentialProvenance,
  LLMAuthIdentity,
} from './identity.js';
export {
  isCredentialReference,
  deriveCredentialRef,
  storeCredentialInput,
  resolveCredentialReference,
  classifyApiKeyConfigValue,
  assertNoLegacyPlaintextApiKey,
  ApiKeyConfigError,
} from './key-input.js';
export type { StoredCredentialInput, ApiKeyConfigValue } from './key-input.js';
export {
  LegacyPresetMigrationError,
  migrateLegacyLLMConfig,
  migrateLegacyProviderConfig,
} from './preset-migration.js';
export type {
  LegacyLLMMigrationResult,
  LegacyPresetMigrationErrorCode,
} from './preset-migration.js';
export { migrateLegacyApiKeysAtPath } from './api-key-migration.js';
export type { ApiKeyMigrationAudit, ApiKeyMigrationOutcome } from './api-key-migration.js';
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
  LLMConfigurationAlreadyExistsError,
  LLMConfigurationRevisionConflictError,
  LLMProviderLabelAlreadyExistsError,
} from './document-store.js';
export {
  LLMConfigurationCredentialUnavailableError,
  providerAtLLMSlot,
  snapshotLLMProviderDraft,
  snapshotLLMProviderTarget,
} from './provider-repair.js';
export type { LLMProviderSnapshot } from './provider-repair.js';
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
  LLMConfigurationDocumentMigrationResult,
  LLMConfigurationCommitResult,
  ExplicitLLMProviderConfig,
} from './document-store.js';
export {
  executeLLMSetupAttempt,
  runLLMSetupWorkflow,
  LLMSetupIdentityChangedError,
  LLMSetupCommittedObserverError,
} from './setup-workflow.js';
export type {
  LLMSetupCommitTarget,
  LLMSetupCandidateDraft,
  LLMSetupDraft,
  LLMSetupErrorType,
  LLMSetupProbeResult,
  LLMSetupCandidateRecord,
  LLMSetupWorkflowEvent,
  LLMSetupVerified,
  LLMSetupAttemptOutcome,
  LLMSetupFailureDisposition,
  LLMSetupWorkflowOutcome,
  LLMSetupWorkflowDeps,
} from './setup-workflow.js';
