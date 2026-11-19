/**
 * @module L4.LLMConfiguration.SetupWorkflow
 *
 * Target-independent explicit draft → probe → repair/cancel → commit state
 * machine. Terminal I/O, authentication and network probes are injected narrow
 * callbacks; this owner never imports CLI/readline or resolves legacy presets.
 */
import { llmProviderConfigContract } from '../../foundation/llm-provider/index.js';
import type { LLMConfigSnapshot } from './identity.js';
import {
  LLMConfigurationAlreadyExistsError,
  type ExplicitLLMProviderConfig,
  type LLMSetupCommitTarget,
  type LLMConfigurationCommitResult,
  type LLMConfigurationDocumentStore,
} from './document-store.js';

const { llmProviderConfigSchema } = llmProviderConfigContract;

export type { LLMSetupCommitTarget } from './document-store.js';

export interface LLMSetupCandidateDraft {
  /** Stable non-secret setup identity (not a credential or preset alias). */
  readonly identity: string;
  readonly config: ExplicitLLMProviderConfig;
}

export interface LLMSetupDraft {
  readonly provider: ExplicitLLMProviderConfig;
  /** Ordered endpoint candidates; first success wins and later entries are not probed. */
  readonly candidates?: readonly LLMSetupCandidateDraft[];
}

export type LLMSetupErrorType = 'auth' | 'model' | 'network' | 'rate_limit' | 'quota' | 'unknown';

export type LLMSetupProbeResult =
  | { readonly ok: true; readonly model: string; readonly snapshot: LLMConfigSnapshot }
  | {
    readonly ok: false;
    readonly errorType: LLMSetupErrorType;
    readonly message: string;
    readonly provider: string;
  };

export interface LLMSetupCandidateRecord {
  readonly identity: string;
  readonly url?: string;
  readonly result: LLMSetupProbeResult;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly winner: boolean;
  readonly kind: 'candidate' | 'direct';
}

export type LLMSetupWorkflowEvent =
  | {
    readonly type: 'probe_attempted';
    readonly identity: string;
    readonly url?: string;
    readonly provider: string;
    readonly model: string;
    readonly startedAt: string;
    readonly kind: 'candidate' | 'direct';
  }
  | {
    readonly type: 'probe_finished';
    readonly identity: string;
    readonly url?: string;
    readonly result: { readonly ok: boolean; readonly model?: string; readonly errorType?: LLMSetupErrorType };
    readonly startedAt: string;
    readonly completedAt: string;
    readonly winner: boolean;
    readonly kind: 'candidate' | 'direct';
  }
  | { readonly type: 'repair'; readonly action: 'retry' | 'replace' }
  | { readonly type: 'cancelled'; readonly reason: string }
  | {
    readonly type: 'committed';
    readonly target: LLMSetupCommitTarget['kind'];
    readonly revision: number;
    readonly identity: string;
  };

export interface LLMSetupVerified {
  readonly snapshot: LLMConfigSnapshot;
  readonly model: string;
}

export type LLMSetupAttemptOutcome =
  | {
    readonly kind: 'committed';
    readonly draft: LLMSetupDraft;
    readonly verified: LLMSetupVerified;
    readonly commit: LLMConfigurationCommitResult;
    readonly candidates: readonly LLMSetupCandidateRecord[];
  }
  | {
    readonly kind: 'repair';
    readonly draft: LLMSetupDraft;
    readonly failure: Extract<LLMSetupProbeResult, { ok: false }>;
    readonly candidates: readonly LLMSetupCandidateRecord[];
  }
  | { readonly kind: 'concurrent' };

export type LLMSetupFailureDisposition =
  | { readonly kind: 'repair'; readonly draft: LLMSetupDraft }
  | { readonly kind: 'retry' }
  | { readonly kind: 'cancel'; readonly reason: string };

export type LLMSetupWorkflowOutcome =
  | Extract<LLMSetupAttemptOutcome, { kind: 'committed' | 'concurrent' }>
  | { readonly kind: 'cancelled'; readonly reason: string };

export class LLMSetupIdentityChangedError extends Error {
  constructor() {
    super('Configuration changed during verification; refusing to commit unverified config (fail-closed)');
    this.name = 'LLMSetupIdentityChangedError';
  }
}

export interface LLMSetupWorkflowDeps {
  readonly store: Pick<LLMConfigurationDocumentStore, 'commitExplicitProvider'>;
  readonly probe: (
    draft: LLMSetupDraft,
    candidate: { readonly identity: string; readonly kind: 'candidate' | 'direct' },
  ) => Promise<LLMSetupProbeResult>;
  /** Rebuild the exact draft identity after probe; false/throw both fail closed. */
  readonly recheckIdentity: (draft: LLMSetupDraft, verified: LLMSetupVerified) => Promise<boolean>;
  readonly emit?: (event: LLMSetupWorkflowEvent) => void;
  readonly now?: () => Date;
}

function validatedDraft(draft: LLMSetupDraft): LLMSetupDraft {
  const provider = llmProviderConfigSchema.parse(draft.provider);
  const candidates = draft.candidates?.map(candidate => {
    if (!candidate.identity) throw new Error('Setup candidate identity is required');
    return { identity: candidate.identity, config: llmProviderConfigSchema.parse(candidate.config) };
  });
  return { provider, ...(candidates !== undefined ? { candidates } : {}) };
}

/** One probe/commit attempt. All endpoint iteration and commit calls live here. */
export async function executeLLMSetupAttempt(
  deps: LLMSetupWorkflowDeps,
  inputDraft: LLMSetupDraft,
  target: LLMSetupCommitTarget,
  expectedRevision?: number,
): Promise<LLMSetupAttemptOutcome> {
  const draft = validatedDraft(inputDraft);
  const now = deps.now ?? (() => new Date());
  const hasCandidates = draft.candidates !== undefined && draft.candidates.length > 0;
  const candidates: LLMSetupCandidateDraft[] = hasCandidates
    ? [...draft.candidates!]
    : [{ identity: draft.provider.provider_id, config: draft.provider }];
  const records: LLMSetupCandidateRecord[] = [];

  const probeOne = async (
    candidate: LLMSetupCandidateDraft,
    kind: 'candidate' | 'direct',
  ): Promise<LLMSetupCandidateRecord> => {
    const candidateDraft: LLMSetupDraft = { provider: candidate.config };
    const url = candidate.config.base_url;
    const startedAt = now().toISOString();
    deps.emit?.({
      type: 'probe_attempted', identity: candidate.identity, ...(url !== undefined ? { url } : {}),
      provider: candidate.config.provider_id, model: candidate.config.model, startedAt, kind,
    });
    const result = await deps.probe(candidateDraft, { identity: candidate.identity, kind });
    const winner = result.ok;
    const completedAt = now().toISOString();
    const record: LLMSetupCandidateRecord = {
      identity: candidate.identity, ...(url !== undefined ? { url } : {}), result,
      startedAt, completedAt, winner, kind,
    };
    deps.emit?.({
      type: 'probe_finished', identity: candidate.identity, ...(url !== undefined ? { url } : {}),
      result: result.ok
        ? { ok: true, model: result.model }
        : { ok: false, errorType: result.errorType },
      startedAt, completedAt, winner, kind,
    });
    return record;
  };

  let selected: LLMSetupCandidateDraft | undefined;
  for (const candidate of candidates) {
    const record = await probeOne(candidate, hasCandidates ? 'candidate' : 'direct');
    records.push(record);
    if (!record.result.ok) {
      if (!hasCandidates) return { kind: 'repair', draft, failure: record.result, candidates: records };
      continue;
    }
    selected = candidate;
    break;
  }

  if (selected === undefined) {
    const failure = records.find(record => !record.result.ok)?.result;
    if (failure === undefined || failure.ok) {
      throw new Error('Setup candidate workflow exhausted without a typed failure');
    }
    return { kind: 'repair', draft, failure, candidates: records };
  }

  // Candidate probes may use a bounded timeout. Verify the exact persistable
  // winner once without that probe-only override before identity recheck/commit.
  if (hasCandidates) {
    const final = await probeOne({ identity: selected.identity, config: selected.config }, 'direct');
    records.push(final);
    if (!final.result.ok) return { kind: 'repair', draft, failure: final.result, candidates: records };
  }
  const finalResult = records[records.length - 1]?.result;
  if (finalResult === undefined || !finalResult.ok) {
    throw new Error('Setup workflow missing final verified probe');
  }
  const candidateDraft: LLMSetupDraft = { provider: selected.config };
  const verified = { snapshot: finalResult.snapshot, model: finalResult.model };
  if (!(await deps.recheckIdentity(candidateDraft, verified))) {
    throw new LLMSetupIdentityChangedError();
  }
  try {
    const commit = await deps.store.commitExplicitProvider(target, selected.config, expectedRevision);
    try {
      deps.emit?.({
        type: 'committed', target: target.kind, revision: commit.revision.revision,
        identity: verified.snapshot.identity,
      });
    } catch {
      // The store commit is authoritative. A post-commit audit/observer failure
      // must not turn an already committed result into an apparent failure.
    }
    return { kind: 'committed', draft: candidateDraft, verified, commit, candidates: records };
  } catch (error) {
    if (error instanceof LLMConfigurationAlreadyExistsError && target.kind === 'initialize') {
      return { kind: 'concurrent' };
    }
    throw error;
  }
}

/** Shared repair loop. CLI adapters choose prompts; business disposition stays here. */
export async function runLLMSetupWorkflow(
  deps: LLMSetupWorkflowDeps,
  draft: LLMSetupDraft,
  target: LLMSetupCommitTarget,
  onFailure: (
    attempt: Extract<LLMSetupAttemptOutcome, { kind: 'repair' }>,
  ) => Promise<LLMSetupFailureDisposition>,
  expectedRevision?: number,
): Promise<LLMSetupWorkflowOutcome> {
  let current = draft;
  for (;;) {
    const attempt = await executeLLMSetupAttempt(deps, current, target, expectedRevision);
    if (attempt.kind !== 'repair') return attempt;
    const disposition = await onFailure(attempt);
    if (disposition.kind === 'cancel') {
      deps.emit?.({ type: 'cancelled', reason: disposition.reason });
      return { kind: 'cancelled', reason: disposition.reason };
    }
    deps.emit?.({ type: 'repair', action: disposition.kind === 'retry' ? 'retry' : 'replace' });
    current = disposition.kind === 'repair' ? disposition.draft : current;
  }
}
