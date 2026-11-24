/** Interactive in-place provider repair shared by config and start. */
import type * as readline from 'node:readline';
import type { RootConfigAdmin } from '../assembly/index.js';
import {
  LLMConfigurationCredentialUnavailableError,
  LegacyPresetMigrationError,
  LLMSetupCommittedObserverError,
  executeLLMSetupAttempt,
  providerAtLLMSlot,
  type LLMConfigurationAdmin,
  type LLMConfigurationCommitResult,
  type LLMProviderSlot,
  type LLMSetupDraft,
  type LLMSetupVerified,
} from '../core/llm-configuration/index.js';
import { getChestnutRoot } from '../foundation/claw-identity/index.js';
import type { AtomicWriteResult, FileSystem } from '../foundation/fs/index.js';
import { formatErr, newUuid } from '../foundation/node-utils/index.js';
import { actionAuditFor } from './action-scope.js';
import { CLI_AUDIT_EVENTS } from './audit-events.js';
import { CliError } from './errors.js';
import {
  collectExplicitLLMConfig,
  discardCreatedCredentials,
  recordCreatedCredential,
  type StoredCredential,
} from './llm-config-editor.js';
import { formatLLMError, LLM_ERROR_HINTS, type LLMRepairAction } from './llm-probe.js';
import {
  emitLLMSetupWorkflowAudit,
  makeLLMSetupWorkflowProbe,
  recheckLLMSetupIdentity,
} from './setup-provider-probe.js';
import { makeExplicitSetupProvider } from './setup-provider-catalog.js';
import { storeKeyAsCredential } from './credentials-prompt.js';
import { passwordQuestion } from './utils/password-prompt.js';
import { question as askQuestion } from './utils/prompt.js';
import {
  formatAmbiguousProviderReference,
  formatProviderTarget,
  providerTargetFingerprint,
  resolveProviderReference,
  type ResolvedProviderReference,
} from './commands/provider-reference.js';
import {
  SETUP_CANCELLED,
  setupConnectingLine,
  setupRepairMenuLines,
} from '../templates/messages/index.js';

export interface ProviderRepairDeps {
  fsFactory(baseDir: string): FileSystem;
  llmConfiguration: Pick<LLMConfigurationAdmin, 'loadRaw' | 'store'> &
    Partial<Pick<LLMConfigurationAdmin, 'migrateLegacyApiKeys'>>;
}

export interface ProviderRepairBaseline {
  readonly config: ReturnType<LLMConfigurationAdmin['loadRaw']>;
  readonly found: ResolvedProviderReference;
}

export type ProviderRepairOutcome =
  | {
    kind: 'committed';
    target: ResolvedProviderReference;
    commit: LLMConfigurationCommitResult;
    verified: LLMSetupVerified;
  }
  | { kind: 'cancelled'; reason: string };

function reportDegraded(write: AtomicWriteResult): void {
  if (write.kind === 'durable') return;
  console.error(`⚠ Provider repair committed with degraded durability (kind=${write.kind}): ${formatErr(write.error)}`);
}

export function providerRepairBaselineForSlot(
  config: ReturnType<LLMConfigurationAdmin['loadRaw']>,
  slot: LLMProviderSlot,
): ProviderRepairBaseline {
  const provider = providerAtLLMSlot({ ...config.llm, revision: config.revision.revision }, slot);
  const found: ResolvedProviderReference = {
    kind: 'resolved',
    candidate: {
      role: slot.role,
      index: slot.role === 'primary' ? -1 : slot.index,
      ...(provider.label !== undefined ? { label: provider.label } : {}),
      ...(provider.provider_id !== undefined ? { provider_id: provider.provider_id } : {}),
      ...(provider.base_url !== undefined ? { base_url: provider.base_url } : {}),
      ...(provider.model !== undefined ? { model: provider.model } : {}),
    },
    matchedBy: provider.label === undefined ? 'provider_id' : 'label',
  };
  return { config, found };
}

function foundForSlot(
  deps: ProviderRepairDeps,
  slot: LLMProviderSlot,
): ProviderRepairBaseline {
  return providerRepairBaselineForSlot(deps.llmConfiguration.loadRaw(), slot);
}

function assertStableTarget(
  deps: ProviderRepairDeps,
  slot: LLMProviderSlot,
  expected: { revision: string; fingerprint: string },
): void {
  const { config, found } = foundForSlot(deps, slot);
  if (config.revision.id !== expected.revision
    || providerTargetFingerprint(config, found) !== expected.fingerprint) {
    throw new CliError('Provider configuration or target changed before repair; no changes applied (provider_target_drift).');
  }
}

function parseChoice(raw: string): LLMRepairAction | undefined {
  switch (raw.trim().toLowerCase()) {
    case '1': case 'retry': return 'retry';
    case '2': case 'key': return 'edit-key';
    case '3': case 'model': return 'edit-model';
    case '4': case 'provider': return 'edit-provider';
    case 'n': case 'cancel': return 'cancel';
    default: return undefined;
  }
}

async function chooseRepairAction(rl: readline.Interface): Promise<LLMRepairAction> {
  setupRepairMenuLines().forEach(line => console.log(line));
  for (;;) {
    const action = parseChoice(await askQuestion(rl, '\n> '));
    if (action !== undefined) return action;
    console.log('Invalid choice.');
  }
}

function reportRemainingCredentialFailures(deps: ProviderRepairDeps): void {
  try {
    deps.llmConfiguration.store.readSnapshot();
  } catch (error) {
    if (error instanceof LLMConfigurationCredentialUnavailableError) {
      console.error(`⚠ Target saved, but the full LLM configuration is not ready: credential unavailable (${error.ref}).`);
      return;
    }
    console.error(`⚠ Target saved, but the full runtime readiness check failed: ${formatErr(error)}`);
  }
}

/** Repair a selected raw slot without resolving credentials in any other provider. */
export async function repairProviderSlot(
  deps: ProviderRepairDeps,
  slot: LLMProviderSlot,
  rl: readline.Interface,
  baseline?: ProviderRepairBaseline,
): Promise<ProviderRepairOutcome> {
  // Resolver and repair must share one raw target baseline; never re-resolve A into B.
  const initial = baseline ?? foundForSlot(deps, slot);
  const expected = {
    revision: initial.config.revision.id,
    fingerprint: providerTargetFingerprint(initial.config, initial.found),
  };
  const expectedRevision = initial.config.revision.revision;
  const created: StoredCredential[] = [];
  let commitAttempted = false;
  let draft: LLMSetupDraft = { provider: providerAtLLMSlot(
    { ...initial.config.llm, revision: expectedRevision }, slot,
  ) };
  assertStableTarget(deps, slot, expected);
  const audit = actionAuditFor(getChestnutRoot(), deps);

  try {
    for (;;) {
      console.log(`\nRepair provider (${formatProviderTarget(initial.found)}):`);
      const action = await chooseRepairAction(rl);
      if (action === 'cancel') {
        console.log(SETUP_CANCELLED);
        return { kind: 'cancelled', reason: 'user_cancelled' };
      }

      if (action === 'edit-key') {
        const raw = await passwordQuestion(rl, 'New API key (b = back): ');
        if (raw === 'b') continue;
        if (!raw) {
          console.log('API key is required.');
          continue;
        }
        const apiKey = await storeKeyAsCredential(deps, raw, {
          seed: `provider-repair-${newUuid()}`, onShadowedEnv: 'error',
        }, { onStored: (ref, info) => recordCreatedCredential(created, ref, info) });
        draft = { provider: { ...draft.provider, api_key: apiKey } };
      } else if (action === 'edit-model') {
        const model = await askQuestion(rl, 'New model (b = back)');
        if (model === 'b') continue;
        if (!model) {
          console.log('Model is required.');
          continue;
        }
        draft = { provider: { ...draft.provider, model } };
      } else if (action === 'edit-provider') {
        const collected = await collectExplicitLLMConfig(
          deps, rl, (prompt, defaultValue) => askQuestion(rl, prompt, defaultValue), created,
          { credentialSeed: `provider-repair-${newUuid()}` },
        );
        if (collected.kind === 'cancelled') {
          console.log(SETUP_CANCELLED);
          return { kind: 'cancelled', reason: collected.reason };
        }
        draft = {
          provider: {
            ...makeExplicitSetupProvider(collected.draft),
            ...(initial.found.candidate.label !== undefined
              ? { label: initial.found.candidate.label }
              : {}),
          },
        };
      }

      console.log(setupConnectingLine(draft.provider.label ?? draft.provider.provider_id, draft.provider.model));
      const outcome = await executeLLMSetupAttempt({
        store: {
          commitExplicitProvider: async (target, config, revision) => {
            assertStableTarget(deps, slot, expected);
            commitAttempted = true;
            return deps.llmConfiguration.store.commitExplicitProvider(target, config, revision);
          },
        },
        probe: makeLLMSetupWorkflowProbe(deps, audit),
        recheckIdentity: (candidate, verified) => recheckLLMSetupIdentity(deps, candidate, verified),
        emit: event => emitLLMSetupWorkflowAudit(audit, event),
      }, draft, { kind: 'replace', slot }, expectedRevision);

      if (outcome.kind === 'concurrent') throw new Error('Unexpected initialize race during provider repair');
      if (outcome.kind === 'repair') {
        formatLLMError({
          errorType: outcome.failure.errorType,
          message: outcome.failure.message,
          provider: outcome.failure.provider,
          hint: LLM_ERROR_HINTS[outcome.failure.errorType],
        }).forEach(line => console.log(line));
        continue;
      }

      reportDegraded(outcome.commit.write);
      try {
        audit.write(
          CLI_AUDIT_EVENTS.CONFIG_SAVED,
          'command=provider_repair',
          `role=${slot.role}`,
          `revision=${outcome.commit.revision.revision}`,
        );
      } catch (error) {
        throw new LLMSetupCommittedObserverError(outcome.commit, { cause: error });
      }
      console.log(`✓ Provider (${formatProviderTarget(initial.found)}) repaired in place at revision ${outcome.commit.revision.revision}`);
      console.log(`✓ ${outcome.verified.model}`);
      reportRemainingCredentialFailures(deps);
      return {
        kind: 'committed', target: initial.found, commit: outcome.commit, verified: outcome.verified,
      };
    }
  } finally {
    if (!commitAttempted) await discardCreatedCredentials(deps, created);
  }
}

/** Commander entry: resolve an exact label or unique provider_id, then repair its slot. */
export async function providerRepair(
  deps: ProviderRepairDeps & {
    rootConfig: Pick<RootConfigAdmin, 'migrateLLMConfiguration'>;
    llmConfiguration: Pick<LLMConfigurationAdmin, 'loadRaw' | 'store' | 'migrateLegacyApiKeys'>;
  },
  reference: string,
  rl: readline.Interface,
): Promise<ProviderRepairOutcome> {
  try {
    await deps.rootConfig.migrateLLMConfiguration();
  } catch (error) {
    if (!(error instanceof LegacyPresetMigrationError) || ![
      'unsupported_headers', 'unsupported_auth', 'credential_ref_required', 'endpoint_required',
    ].includes(error.code)) throw error;
    console.error(`⚠ Legacy provider requires explicit repair (${error.code} at ${error.role}); source preserved.`);
  }
  await deps.llmConfiguration.migrateLegacyApiKeys(actionAuditFor(getChestnutRoot(), deps));
  const config = deps.llmConfiguration.loadRaw();
  const resolution = resolveProviderReference(config, reference);
  if (resolution.kind === 'not_found') throw new CliError(`Provider "${reference}" not found`);
  if (resolution.kind === 'ambiguous_provider_reference') {
    throw new CliError(formatAmbiguousProviderReference(resolution));
  }
  const slot: LLMProviderSlot = resolution.candidate.role === 'primary'
    ? { role: 'primary' }
    : { role: 'fallback', index: resolution.candidate.index };
  return repairProviderSlot(deps, slot, rl, { config, found: resolution });
}
