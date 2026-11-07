import { formatErr } from '../node-utils/index.js';
import type { LLMEventSink, LLMInstanceLifecycle } from './types.js';
import {
  createEmptyLLMInstanceState,
  loadLLMInstanceState,
  saveLLMInstanceState,
  upgradeLLMInstanceState,
  type LLMInstanceRecoveryState,
  type LLMInstanceStateV1,
  type LLMInstanceStateV2,
  type LLMInstanceStateV3,
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
  force?: boolean;
  /** Store 提交成功后、degraded 事件前同步 facade 只读投影。 */
  publish?: () => void;
}

export interface InstanceStateStore {
  load(publish?: (state: LLMInstanceStateV3) => void): LLMInstanceStateV3;
  readonly revision: number;
  readonly state: LLMInstanceStateV3;
  commit(
    context: string,
    candidate: InstanceStateCandidate,
    options?: InstanceStateCommitOptions,
  ): InstanceStateCommitResult;
}

export type InstanceStateStoreOptions = LLMInstanceLifecycle & {
  providerIds: readonly string[];
  legacyProviderIds: readonly string[];
  events: LLMEventSink;
  now?: () => number;
};

/** V3 的唯一读写 owner；legacy intake、revision 与原子提交均在此收口。 */
export class LLMInstanceStateStore implements InstanceStateStore {
  private current: LLMInstanceStateV3;
  private readonly providerIds: readonly string[];
  private readonly legacyProviderIds: readonly string[];
  private readonly events: LLMEventSink;
  private readonly now: () => number;

  constructor(private readonly options: InstanceStateStoreOptions) {
    this.providerIds = [...options.providerIds];
    this.legacyProviderIds = [...options.legacyProviderIds];
    this.events = options.events;
    this.now = options.now ?? Date.now;
    this.current = createEmptyLLMInstanceState();
  }

  get revision(): number {
    return this.current.revision;
  }

  get state(): LLMInstanceStateV3 {
    return this.current;
  }

  load(publish?: (state: LLMInstanceStateV3) => void): LLMInstanceStateV3 {
    if (this.options.mode === 'ephemeral') {
      this.current = createEmptyLLMInstanceState();
      publish?.(this.current);
      return this.current;
    }

    const loaded = loadLLMInstanceState(this.options.fs, this.options.stateDir);
    if (loaded.kind === 'unusable') {
      throw new Error(`LLM instance state is unusable (${loaded.reason}): ${loaded.detail}`);
    }
    if (loaded.kind === 'ok') {
      // V3 存在即唯一权威；即使旧文件仍存在，也不再读取或合并。
      this.current = loaded.state;
      publish?.(this.current);
      return this.current;
    }

    const legacyHealth: LLMInstanceStateV1 | LLMInstanceStateV2 | undefined = loaded.kind === 'legacy'
      ? loaded.state
      : undefined;
    // 先旧 scope，再由 intake 在 scope 缺失时读取已知旧 EventLoop retry 文件。
    const legacyRecovery = loadRecoveryState(
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
    let migrated: LLMInstanceStateV3;
    try {
      migrated = upgradeLLMInstanceState(
        legacyHealth,
        legacyRecovery.kind === 'ok' ? legacyRecovery.state : undefined,
        this.now(),
        this.providerIds,
        this.legacyProviderIds,
      );
    } catch (error) {
      throw new Error(`Legacy LLM recovery migration failed: ${formatErr(error)}`, { cause: error });
    }
    // 初始迁移保持原语义：rename 前失败拒绝启动；rename 后降级仍发布并留证。
    const result = saveLLMInstanceState(this.options.fs, migrated, this.options.stateDir);
    this.current = migrated;
    publish?.(this.current);
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
    const current = this.project({
      providers: this.current.providers,
      recovery: this.current.recovery,
    }, providerIds, this.current.revision, '');
    const comparable = this.project(candidate, providerIds, this.current.revision, '');
    const persistentChanged = options.force === true
      || JSON.stringify(current.providers) !== JSON.stringify(comparable.providers)
      || JSON.stringify(current.recovery) !== JSON.stringify(comparable.recovery);

    if (!persistentChanged) {
      this.current = this.project(candidate, providerIds, this.current.revision, this.current.updatedAt);
      options.publish?.();
      return { kind: 'unchanged', revision: this.current.revision };
    }

    const next = this.project(
      candidate,
      providerIds,
      this.current.revision + 1,
      new Date(this.now()).toISOString(),
    );
    if (this.options.mode === 'ephemeral') {
      this.current = next;
      options.publish?.();
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

    // rename 已提交后才发布候选；degraded 事件仍在调用方后续恢复事件之前。
    this.current = next;
    options.publish?.();
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
    revision: number,
    updatedAt: string,
  ): LLMInstanceStateV3 {
    const byId = new Map(candidate.providers.map(provider => [provider.providerId, provider]));
    return {
      schema_version: 3,
      instanceId: this.current.instanceId,
      revision,
      updatedAt,
      providers: providerIds.flatMap(providerId => {
        const provider = byId.get(providerId);
        return provider ? [{ ...provider }] : [];
      }),
      recovery: candidate.recovery,
    };
  }
}
