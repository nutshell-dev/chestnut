import * as path from 'path';
import { formatErr, sha256Hex } from '../node-utils/index.js';
import { isFileNotFound } from '../fs/index.js';
import type { LLMEventSink, LLMInstanceLifecycle } from './types.js';
import {
  createEmptyLLMInstanceState,
  loadLLMInstanceState,
  saveLLMInstanceState,
  upgradeLLMInstanceState,
  LLM_INSTANCE_STATE_FILE,
  type LLMInstanceMigrationMetadata,
  type LLMInstanceMigrationTransition,
  type LLMInstanceRecoveryState,
  type LLMInstanceStateV1,
  type LLMInstanceStateV2,
  type LLMInstanceStateV3,
  type LLMInstanceStateV4,
  type LLMProviderRecoveryState,
} from './instance-state.js';
import { loadRecoveryState } from './recovery-state.js';
import {
  LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
  LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
} from './defaults.js';

export interface InstanceStateCandidate {
  providers: LLMProviderRecoveryState[];
  recovery: LLMInstanceRecoveryState;
}

export type InstanceStateCommitResult =
  | { kind: 'durable' | 'ephemeral' | 'unchanged'; revision: number }
  | { kind: 'committed_platform_limited' | 'committed_durability_unknown'; revision: number; error: Error }
  | { kind: 'failed'; error: Error };

export interface InstanceStateCommitOptions {
  providerIds?: readonly string[];
  operationalIdentities?: readonly string[];
  force?: boolean;
}

export interface InstanceStateSnapshot {
  readonly instanceId: string;
  readonly recovery: LLMInstanceRecoveryState;
  readonly revision: number;
  readonly providers: readonly LLMProviderRecoveryState[];
}

export interface InstanceStateStore {
  load(): LLMInstanceStateV4;
  snapshot(): InstanceStateSnapshot;
  readonly revision: number;
  readonly state: LLMInstanceStateV4;
  commit(
    context: string,
    candidate: InstanceStateCandidate,
    options?: InstanceStateCommitOptions,
  ): InstanceStateCommitResult;
}

export type InstanceStateStoreOptions = LLMInstanceLifecycle & {
  providerIds: readonly string[];
  operationalIdentities: readonly string[];
  /** Old descriptor.identity values, aligned with current entries. */
  connectionProviderIds?: readonly string[];
  /** Old descriptor.legacyIdentity values, aligned with current entries. */
  legacyProviderIds: readonly string[];
  events: LLMEventSink;
  now?: () => number;
};

interface EvidenceSource {
  path: string;
  digest: string;
  content: unknown;
}

interface MigrationPlan {
  providers: LLMProviderRecoveryState[];
  transitions: LLMInstanceMigrationTransition[];
}

/** V4's sole read/write owner; legacy intake and transition evidence are atomic prerequisites. */
export class LLMInstanceStateStore implements InstanceStateStore {
  private current: LLMInstanceStateV4;
  private providerIds: readonly string[];
  private operationalIdentities: readonly string[];
  private readonly connectionProviderIds: readonly string[];
  private readonly legacyProviderIds: readonly string[];
  private readonly events: LLMEventSink;
  private readonly now: () => number;

  constructor(private readonly options: InstanceStateStoreOptions) {
    if (options.operationalIdentities.length !== options.providerIds.length) {
      throw new Error('LLM provider and operational identity counts differ');
    }
    this.providerIds = [...options.providerIds];
    this.operationalIdentities = [...options.operationalIdentities];
    this.connectionProviderIds = [...(options.connectionProviderIds ?? options.legacyProviderIds)];
    this.legacyProviderIds = [...options.legacyProviderIds];
    this.events = options.events;
    this.now = options.now ?? Date.now;
    this.current = createEmptyLLMInstanceState();
  }

  get revision(): number { return this.current.revision; }
  get state(): LLMInstanceStateV4 { return this.current; }

  snapshot(): InstanceStateSnapshot {
    return structuredClone({
      instanceId: this.current.instanceId,
      recovery: this.current.recovery,
      revision: this.current.revision,
      providers: this.current.providers,
    });
  }

  load(): LLMInstanceStateV4 {
    if (this.options.mode === 'ephemeral') {
      this.current = createEmptyLLMInstanceState();
      return this.current;
    }

    const loaded = loadLLMInstanceState(this.options.fs, this.options.stateDir);
    if (loaded.kind === 'unusable') {
      throw new Error(`LLM instance state is unusable (${loaded.reason}): ${loaded.detail}`);
    }
    if (loaded.kind === 'ok') {
      // V4 is authoritative: neither legacy recovery sidecars nor migration evidence are read.
      this.current = loaded.state;
      const providers = this.reconcileCurrentProviders(this.current.providers);
      if (JSON.stringify(providers) !== JSON.stringify(this.current.providers)) {
        const result = this.commit('operational_identity', {
          providers,
          recovery: this.current.recovery,
        }, { force: true });
        if (result.kind === 'failed') {
          throw new Error('LLM instance state persistence failed during operational identity reconciliation', { cause: result.error });
        }
      }
      return this.current;
    }

    const legacyHealth: LLMInstanceStateV1 | LLMInstanceStateV2 | undefined = loaded.kind === 'legacy'
      && loaded.state.schema_version !== 3 ? loaded.state : undefined;
    // V2/V3 already embed their authoritative recovery facts. Only V1/missing
    // use the historical sidecar intake; an unrelated corrupt sidecar must not
    // block those newer snapshots.
    const legacyRecovery = loaded.kind === 'legacy' && loaded.state.schema_version !== 1
      ? { kind: 'missing' } as const
      : loadRecoveryState(
        this.options.fs,
        'foreground',
        this.options.stateDir,
        {
          retryCount: 0,
          retryDelayMs: LLM_RECOVERY_RETRY_INITIAL_DELAY_MS,
          quotaDelayMs: LLM_RECOVERY_QUOTA_INITIAL_DELAY_MS,
        },
        this.now(),
      );
    if (legacyRecovery.kind === 'unusable') {
      throw new Error(`Legacy LLM recovery state is unusable (${legacyRecovery.reason}): ${legacyRecovery.detail}`);
    }

    let legacyV3: LLMInstanceStateV3;
    try {
      legacyV3 = loaded.kind === 'legacy' && loaded.state.schema_version === 3
        ? structuredClone(loaded.state)
        : upgradeLLMInstanceState(
          legacyHealth,
          legacyRecovery.kind === 'ok' ? legacyRecovery.state : undefined,
          this.now(),
          this.providerIds,
          this.legacyProviderIds,
          this.connectionProviderIds,
        );
    } catch (error) {
      throw new Error(`Legacy LLM recovery migration failed: ${formatErr(error)}`, { cause: error });
    }

    const hasLegacySource = loaded.kind === 'legacy' || legacyRecovery.kind === 'ok';
    const plan = this.planLegacyMigration(legacyV3.providers);
    let migration: LLMInstanceMigrationMetadata | undefined;
    if (hasLegacySource) {
      const sources: EvidenceSource[] = [];
      if (loaded.kind === 'legacy') {
        sources.push(this.evidenceSource(
          path.join(this.options.stateDir ?? 'status', LLM_INSTANCE_STATE_FILE),
          loaded.raw,
        ));
      }
      if (legacyRecovery.kind === 'ok') {
        sources.push(this.evidenceSource(legacyRecovery.source.path, legacyRecovery.source.raw));
      }
      migration = this.writeMigrationEvidence(sources, plan.transitions);
    }

    const migrated: LLMInstanceStateV4 = {
      schema_version: 4,
      instanceId: legacyV3.instanceId,
      revision: loaded.kind === 'legacy' && loaded.state.schema_version === 3
        ? legacyV3.revision + 1
        : legacyV3.revision,
      updatedAt: new Date(this.now()).toISOString(),
      providers: plan.providers as LLMInstanceStateV4['providers'],
      recovery: legacyV3.recovery,
      ...(migration !== undefined ? { migration } : {}),
    };
    // Evidence is durable before this rename can replace the original snapshot.
    const result = saveLLMInstanceState(this.options.fs, migrated, this.options.stateDir);
    this.current = migrated;
    if (result.kind !== 'durable') {
      this.events.emit({
        type: 'instance_state_write_degraded',
        context: 'migration',
        durability: result.kind,
        reason: formatErr(result.error),
      });
    }
    return this.current;
  }

  commit(
    context: string,
    candidate: InstanceStateCandidate,
    options: InstanceStateCommitOptions = {},
  ): InstanceStateCommitResult {
    const providerIds = options.providerIds ?? this.providerIds;
    const operationalIdentities = options.operationalIdentities ?? this.operationalIdentities;
    const current = this.project({
      providers: this.current.providers,
      recovery: this.current.recovery,
    }, providerIds, operationalIdentities, this.current.revision, '');
    const comparable = this.project(candidate, providerIds, operationalIdentities, this.current.revision, '');
    const persistentChanged = options.force === true
      || JSON.stringify(current.providers) !== JSON.stringify(comparable.providers)
      || JSON.stringify(current.recovery) !== JSON.stringify(comparable.recovery);

    if (!persistentChanged) {
      this.current = this.project(candidate, providerIds, operationalIdentities, this.current.revision, this.current.updatedAt);
      this.providerIds = [...providerIds];
      this.operationalIdentities = [...operationalIdentities];
      return { kind: 'unchanged', revision: this.current.revision };
    }

    const next = this.project(
      candidate,
      providerIds,
      operationalIdentities,
      this.current.revision + 1,
      new Date(this.now()).toISOString(),
    );
    if (this.options.mode === 'ephemeral') {
      this.current = next;
      this.providerIds = [...providerIds];
      this.operationalIdentities = [...operationalIdentities];
      return { kind: 'ephemeral', revision: next.revision };
    }

    let durability: ReturnType<typeof saveLLMInstanceState>;
    try {
      durability = saveLLMInstanceState(this.options.fs, next, this.options.stateDir);
    } catch (error) {
      this.events.emit({ type: 'instance_state_write_failed', context, reason: formatErr(error) });
      return {
        kind: 'failed',
        error: error instanceof Error ? error : new Error(formatErr(error)),
      };
    }

    this.current = next;
    this.providerIds = [...providerIds];
    this.operationalIdentities = [...operationalIdentities];
    if (durability.kind !== 'durable') {
      this.events.emit({
        type: 'instance_state_write_degraded',
        context,
        durability: durability.kind,
        reason: formatErr(durability.error),
      });
      return { kind: durability.kind, revision: next.revision, error: durability.error };
    }
    return { kind: 'durable', revision: next.revision };
  }

  private project(
    candidate: InstanceStateCandidate,
    providerIds: readonly string[],
    operationalIdentities: readonly string[],
    revision: number,
    updatedAt: string,
  ): LLMInstanceStateV4 {
    const byId = new Map(candidate.providers.map(provider => [provider.providerId, provider]));
    return {
      schema_version: 4,
      instanceId: this.current.instanceId,
      revision,
      updatedAt,
      providers: providerIds.flatMap((providerId, index) => {
        const provider = byId.get(providerId);
        if (!provider) return [];
        const operationalIdentity = operationalIdentities[index] ?? provider.operationalIdentity;
        if (operationalIdentity === undefined) {
          throw new Error(`Missing operational identity for ${providerId}`);
        }
        return [{ ...provider, providerId, operationalIdentity }];
      }),
      recovery: candidate.recovery,
      ...(this.current.migration !== undefined ? { migration: this.current.migration } : {}),
    };
  }

  private reconcileCurrentProviders(
    providers: readonly LLMProviderRecoveryState[],
  ): LLMProviderRecoveryState[] {
    const byId = new Map(providers.map(provider => [provider.providerId, provider]));
    return this.providerIds.flatMap((providerId, index) => {
      const previous = byId.get(providerId);
      if (!previous) return [];
      const operationalIdentity = this.operationalIdentities[index];
      if (operationalIdentity === undefined) throw new Error(`Missing operational identity for ${providerId}`);
      if (previous.operationalIdentity === operationalIdentity) return [{ ...previous }];
      // Only this entry changed: health, errors, backoff and sticky selection do not cross versions.
      return [{
        providerId,
        status: 'available' as const,
        operationalIdentity,
        previousOperationalIdentity: previous.operationalIdentity,
        operationalChangeReason: 'operational_identity_changed' as const,
      }];
    });
  }

  private planLegacyMigration(providers: readonly LLMProviderRecoveryState[]): MigrationPlan {
    const matches = providers.map(provider => {
      const candidates = this.providerIds.flatMap((providerId, index) => {
        const oldIds = [this.connectionProviderIds[index], this.legacyProviderIds[index], providerId];
        return oldIds.includes(provider.providerId) ? [index] : [];
      });
      return { provider, candidates };
    });
    const proposedTargets = new Map<number, number>();
    for (const { provider, candidates } of matches) {
      if (candidates.length !== 1 || provider.operationalIdentity === undefined) continue;
      const target = candidates[0]!;
      if (provider.operationalIdentity === this.operationalIdentities[target]) {
        proposedTargets.set(target, (proposedTargets.get(target) ?? 0) + 1);
      }
    }

    const transitions: LLMInstanceMigrationTransition[] = [];
    const inherited = new Map<string, LLMProviderRecoveryState>();
    for (const { provider, candidates } of matches) {
      let transition: LLMInstanceMigrationTransition;
      if (candidates.length === 0) {
        transition = { sourceProviderId: provider.providerId, classification: 'unmatched' };
      } else if (candidates.length > 1) {
        transition = { sourceProviderId: provider.providerId, classification: 'ambiguous' };
      } else {
        const target = candidates[0]!;
        const targetProviderId = this.providerIds[target]!;
        const operationalIdentity = this.operationalIdentities[target];
        if (provider.operationalIdentity === undefined) {
          transition = { sourceProviderId: provider.providerId, classification: 'missing_execution_identity' };
        } else if (operationalIdentity === undefined || provider.operationalIdentity !== operationalIdentity) {
          transition = { sourceProviderId: provider.providerId, classification: 'execution_identity_mismatch' };
        } else if ((proposedTargets.get(target) ?? 0) > 1) {
          transition = { sourceProviderId: provider.providerId, classification: 'ambiguous' };
        } else {
          transition = { sourceProviderId: provider.providerId, classification: 'inherited', targetProviderId };
          inherited.set(targetProviderId, { ...provider, providerId: targetProviderId, operationalIdentity });
        }
      }
      transitions.push(transition);
    }
    return {
      providers: this.providerIds.flatMap(providerId => {
        const provider = inherited.get(providerId);
        return provider ? [provider] : [];
      }),
      transitions,
    };
  }

  private evidenceSource(sourcePath: string, raw: string): EvidenceSource {
    return { path: sourcePath, digest: sha256Hex(raw), content: JSON.parse(raw) as unknown };
  }

  private writeMigrationEvidence(
    sources: readonly EvidenceSource[],
    transitions: readonly LLMInstanceMigrationTransition[],
  ): LLMInstanceMigrationMetadata {
    if (this.options.mode !== 'durable') throw new Error('Ephemeral state has no migration evidence owner');
    const fs = this.options.fs;
    const sourceDigest = sha256Hex(sources.map(source => `${source.path}\0${source.digest}`).join('\n'));
    const candidates = this.providerIds.map((providerId, index) => ({
      providerId,
      connectionProviderId: this.connectionProviderIds[index],
      legacyProviderId: this.legacyProviderIds[index],
      operationalIdentity: this.operationalIdentities[index],
    }));
    const evidence = {
      schema_version: 1,
      identity_protocol: 'entry-operational-v4',
      source_digest: sourceDigest,
      sources,
      candidates,
      transitions,
    };
    // Address the complete conversion, not only the old bytes. If a failed first
    // attempt is retried with different credentials/candidates, it gets a new
    // evidence artifact instead of permanently conflicting with the first one.
    const evidenceDigest = sha256Hex(JSON.stringify(evidence));
    const evidencePath = path.join(
      this.options.stateDir ?? 'status',
      `llm-instance-state-migration-${evidenceDigest}.json`,
    );
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    fs.ensureDirSync(this.options.stateDir ?? 'status');
    try {
      const existing = fs.readSync(evidencePath);
      if (existing !== serialized) {
        throw new Error(`Conflicting LLM instance migration evidence: ${evidencePath}`);
      }
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
      const result = fs.writeAtomicSync(evidencePath, serialized);
      if (result.kind !== 'durable') {
        throw new Error(`LLM instance migration evidence was not durable: ${evidencePath}`, { cause: result.error });
      }
    }
    return {
      sourceDigest,
      evidencePath,
      transitions: transitions.map(transition => ({ ...transition })),
    };
  }
}
