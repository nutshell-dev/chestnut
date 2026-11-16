/**
 * Pure append-only replay of LLM orchestration selection facts.
 *
 * This ledger restores business choices; InputMeasurementLedger independently
 * restores request evidence. Neither ledger guesses a winner from timestamps,
 * provider names, adjacent rows, or input measurements.
 */

export type SelectionState =
  | 'started' | 'running' | 'failed' | 'succeeded'
  | 'selected' | 'discarded' | 'cancelled' | 'exhausted' | 'corrupt';

export interface CallAttemptResult {
  readonly invocationId: string;
  readonly attemptId?: string;
  readonly providerAttemptId?: string;
  readonly attemptIndex?: number;
  readonly provider: string;
  readonly providerId?: string;
  readonly outcome: 'started' | 'running' | 'success' | 'failure' | 'skipped' | 'discarded' | 'cancelled';
  readonly requestIds?: readonly string[];
  readonly errorClass?: string;
  readonly error?: string;
  readonly reason?: string;
}

export interface InvocationAttemptReplayState {
  readonly providerAttemptId: string;
  readonly provider: string;
  readonly providerId?: string;
  readonly requestIds: readonly string[];
  readonly status: SelectionState;
  readonly attemptIndex?: number;
  readonly attemptResult?: CallAttemptResult;
}

export interface InvocationReplayState {
  readonly attempts: ReadonlyMap<string, InvocationAttemptReplayState>;
  readonly selectedAttemptId?: string;
  readonly status: 'open' | 'selected' | 'exhausted' | 'corrupt';
}

export interface ReplayDiagnostic {
  readonly code: string;
  readonly invocationId: string;
  readonly attemptId?: string;
  readonly detail: string;
}

export interface InvocationSelectionReplayState {
  readonly schemaVersion: 1;
  readonly invocations: ReadonlyMap<string, InvocationReplayState>;
  readonly diagnostics: readonly ReplayDiagnostic[];
}

interface InternalInvocation {
  readonly invocationId: string;
  readonly attempts: Map<string, InvocationAttemptReplayState>;
  readonly selections: NormalizedSelection[];
  readonly cleanups: NormalizedCleanup[];
  started: boolean;
  selectionSeen: boolean;
  selectedAttemptId?: string;
  exhausted: boolean;
  corrupt: boolean;
}

interface NormalizedSelection {
  readonly invocationId: string;
  readonly attemptId?: string;
  readonly providerAttemptId?: string;
  readonly attemptIndex?: number;
  readonly provider?: string;
  readonly outcome: 'selected' | 'exhausted';
}

interface NormalizedCleanup {
  readonly invocationId: string;
  readonly attemptId?: string;
  readonly providerAttemptId?: string;
  readonly provider?: string;
}

/** Reload boundary for stream.jsonl; malformed records remain explicit. */
export class InvocationSelectionLedger {
  static replay(events: Iterable<unknown>): InvocationSelectionReplayState {
    return replayEvents(events, []);
  }

  static replayJsonl(jsonl: string): InvocationSelectionReplayState {
    const events: unknown[] = [];
    const diagnostics: ReplayDiagnostic[] = [];
    const lines = jsonl.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // silent: malformed input is returned as an invalid_json diagnostic.
        diagnostics.push({
          code: 'invalid_json', invocationId: `line:${index + 1}`,
          detail: 'invocation selection stream line is not valid JSON',
        });
      }
    }
    return replayEvents(events, diagnostics);
  }
}

function replayEvents(
  events: Iterable<unknown>,
  diagnostics: ReplayDiagnostic[],
): InvocationSelectionReplayState {
  const invocations = new Map<string, InternalInvocation>();
  try {
    for (const event of events) collectEvent(event, invocations, diagnostics);
  } catch (error) {
    // silent: iteration failure is returned as replay_failed with partial facts.
    diagnostics.push({
      code: 'replay_failed', invocationId: 'unknown',
      detail: error instanceof Error ? error.message : 'event iteration failed',
    });
  }

  for (const invocation of invocations.values()) {
    if (!invocation.started) {
      invocation.corrupt = true;
      diagnose(diagnostics, 'missing_started', invocation, 'invocation start fact is missing');
    }
    for (const selection of invocation.selections) applySelection(invocation, selection, diagnostics);
    for (const cleanup of invocation.cleanups) applyCleanup(invocation, cleanup, diagnostics);
    finalizeInvocation(invocation, diagnostics);
  }

  const projected = new Map<string, InvocationReplayState>();
  for (const [invocationId, invocation] of invocations) {
    projected.set(invocationId, {
      attempts: invocation.attempts,
      ...(invocation.selectedAttemptId !== undefined
        ? { selectedAttemptId: invocation.selectedAttemptId }
        : {}),
      status: invocation.corrupt
        ? 'corrupt'
        : invocation.selectedAttemptId !== undefined
          ? 'selected'
          : invocation.exhausted ? 'exhausted' : 'open',
    });
  }
  return { schemaVersion: 1, invocations: projected, diagnostics };
}

function collectEvent(
  value: unknown,
  invocations: Map<string, InternalInvocation>,
  diagnostics: ReplayDiagnostic[],
): void {
  if (!isRecord(value)) return;
  const type = normalizeType(value.type);
  if (type === undefined) return;
  const invocationId = stringField(value.invocationId) ?? stringField(value.invocation) ?? '';
  const attemptId = stringField(value.attemptId) ?? nonempty(stringField(value.attempt));
  if (!invocationId) {
    diagnose(diagnostics, 'invalid_event', { invocationId: 'unknown' }, 'missing invocationId', attemptId);
    return;
  }
  const invocation = invocationFor(invocations, invocationId);
  if (!acceptSchema(value, invocation, diagnostics)) return;

  if (type === 'call_invocation_started') {
    if (invocation.started) {
      diagnose(diagnostics, 'duplicate_started', invocation, 'kept first invocation start fact');
      return;
    }
    // A reload may expose the start after later facts; ordering is not a winner signal.
    invocation.started = true;
    return;
  }
  if (type === 'call_attempt_result') {
    collectAttempt(value, invocation, attemptId, diagnostics);
    return;
  }
  if (type === 'call_selection') {
    const outcome = value.outcome;
    if (outcome !== 'selected' && outcome !== 'exhausted') {
      invocation.corrupt = true;
      diagnose(diagnostics, 'invalid_selection', invocation, `outcome=${String(outcome)}`);
      return;
    }
    invocation.selections.push({
      invocationId, ...(attemptId !== undefined ? { attemptId } : {}),
      ...identityFields(value), provider: stringField(value.provider), outcome,
    });
    return;
  }
  if (type === 'race_loser_cleaned') {
    invocation.cleanups.push({
      invocationId, ...(attemptId !== undefined ? { attemptId } : {}),
      ...identityFields(value), provider: stringField(value.provider),
    });
  }
  // hedge_fallback_committed is corroborating telemetry, never a selection input.
}

function collectAttempt(
  event: Record<string, unknown>,
  invocation: InternalInvocation,
  attemptId: string | undefined,
  diagnostics: ReplayDiagnostic[],
): void {
  const provider = stringField(event.provider);
  const outcome = event.outcome;
  const identity = identityFields(event);
  const providerAttemptId = attemptKey(identity, attemptId);
  const validOutcomes = new Set(['started', 'running', 'success', 'failure', 'skipped', 'discarded', 'cancelled']);
  if (!provider || providerAttemptId === undefined || !validOutcomes.has(String(outcome))) {
    invocation.corrupt = true;
    diagnose(diagnostics, 'invalid_attempt', invocation, 'missing provider attempt identity/provider or invalid outcome');
    return;
  }
  if (invocation.attempts.has(providerAttemptId)) {
    diagnose(diagnostics, 'duplicate_attempt_result', invocation, 'kept first provider attempt fact', providerAttemptId);
    return;
  }

  const requestIds = parseRequestIds(event.requestIds ?? event.request_ids);
  const result: CallAttemptResult = {
    invocationId: invocation.invocationId,
    ...(attemptId !== undefined ? { attemptId } : {}),
    providerAttemptId,
    ...(identity.attemptIndex !== undefined ? { attemptIndex: identity.attemptIndex } : {}),
    provider,
    ...(stringField(event.providerId) ?? stringField(event.provider_id)
      ? { providerId: stringField(event.providerId) ?? stringField(event.provider_id) }
      : {}),
    outcome: outcome as CallAttemptResult['outcome'],
    ...(requestIds !== undefined ? { requestIds } : {}),
    ...(stringField(event.errorClass) ?? nonempty(stringField(event.error_class))
      ? { errorClass: stringField(event.errorClass) ?? nonempty(stringField(event.error_class)) }
      : {}),
    ...(stringField(event.error) ? { error: stringField(event.error) } : {}),
    ...(stringField(event.reason) ? { reason: stringField(event.reason) } : {}),
  };
  const status = attemptStatus(result.outcome);
  invocation.attempts.set(providerAttemptId, {
    providerAttemptId, provider,
    ...(result.providerId !== undefined ? { providerId: result.providerId } : {}),
    requestIds: requestIds ?? [],
    status,
    ...(result.attemptIndex !== undefined ? { attemptIndex: result.attemptIndex } : {}),
    ...(status !== 'started' && status !== 'running' ? { attemptResult: result } : {}),
  });
  if (requestIds === undefined && result.outcome !== 'skipped') {
    diagnose(diagnostics, 'legacy_request_link', invocation,
      'attempt has no requestIds; input conservation is not established', providerAttemptId);
  } else if (requestIds?.length === 0 && result.outcome !== 'skipped' && result.outcome !== 'started' && result.outcome !== 'running') {
    diagnose(diagnostics, 'missing_request_link', invocation,
      'terminal attempt has no linked request; input conservation is not established', providerAttemptId);
  }
}

function applySelection(
  invocation: InternalInvocation,
  selection: NormalizedSelection,
  diagnostics: ReplayDiagnostic[],
): void {
  if (invocation.selectionSeen) {
    diagnose(diagnostics, selection.outcome === 'selected' ? 'duplicate_selected' : 'duplicate_selection',
      invocation, 'kept first invocation selection');
    return;
  }
  invocation.selectionSeen = true;
  if (selection.outcome === 'exhausted') {
    invocation.exhausted = true;
    return;
  }
  const providerAttemptId = resolveAttempt(invocation, selection);
  const attempt = providerAttemptId === undefined ? undefined : invocation.attempts.get(providerAttemptId);
  if (providerAttemptId === undefined || attempt === undefined) {
    invocation.corrupt = true;
    diagnose(diagnostics, 'unknown_attempt', invocation, 'selected attempt is unknown or ambiguous');
    return;
  }
  if (attempt.status !== 'succeeded' || attempt.attemptResult?.outcome !== 'success') {
    invocation.corrupt = true;
    diagnose(diagnostics, 'incomplete_selection', invocation, 'selected attempt has no success terminal', providerAttemptId);
    return;
  }
  if (selection.provider !== undefined && selection.provider !== attempt.provider) {
    invocation.corrupt = true;
    diagnose(diagnostics, 'selection_attempt_mismatch', invocation, 'selection provider differs from attempt', providerAttemptId);
    return;
  }
  invocation.selectedAttemptId = providerAttemptId;
  invocation.attempts.set(providerAttemptId, { ...attempt, status: 'selected' });
  for (const [id, candidate] of invocation.attempts) {
    if (id !== providerAttemptId && candidate.status === 'succeeded') {
      invocation.attempts.set(id, { ...candidate, status: 'discarded' });
    }
  }
}

function applyCleanup(
  invocation: InternalInvocation,
  cleanup: NormalizedCleanup,
  diagnostics: ReplayDiagnostic[],
): void {
  let providerAttemptId = resolveAttempt(invocation, cleanup);
  if (providerAttemptId === undefined && cleanup.provider !== undefined) {
    const matches = [...invocation.attempts.values()]
      .filter(attempt => attempt.provider === cleanup.provider);
    if (matches.length === 1) providerAttemptId = matches[0]!.providerAttemptId;
  }
  const attempt = providerAttemptId === undefined ? undefined : invocation.attempts.get(providerAttemptId);
  if (providerAttemptId === undefined || attempt === undefined) {
    diagnose(diagnostics, 'unknown_cleanup', invocation, 'race loser cleanup has no unique attempt');
    return;
  }
  if (attempt.status === 'selected') {
    diagnose(diagnostics, 'selected_cleanup_conflict', invocation,
      'cleanup cannot overwrite selected attempt', providerAttemptId);
    return;
  }
  if (attempt.status === 'succeeded') {
    invocation.attempts.set(providerAttemptId, { ...attempt, status: 'discarded' });
  } else if (attempt.status === 'started' || attempt.status === 'running') {
    invocation.attempts.set(providerAttemptId, { ...attempt, status: 'cancelled' });
  }
}

function finalizeInvocation(invocation: InternalInvocation, diagnostics: ReplayDiagnostic[]): void {
  if (invocation.exhausted) {
    const incomplete = invocation.attempts.size === 0 || [...invocation.attempts.values()].some(attempt =>
      attempt.status === 'started' || attempt.status === 'running' || attempt.attemptResult === undefined);
    if (incomplete) {
      invocation.corrupt = true;
      diagnose(diagnostics, 'incomplete_invocation', invocation, 'exhausted invocation lacks attempt terminals');
    }
    return;
  }
  if (invocation.started && invocation.selectedAttemptId === undefined && !invocation.corrupt) {
    diagnose(diagnostics, 'incomplete_invocation', invocation, 'invocation has no final selection');
  }
}

function resolveAttempt(
  invocation: InternalInvocation,
  reference: { attemptId?: string; providerAttemptId?: string; attemptIndex?: number },
): string | undefined {
  const direct = attemptKey(reference, reference.attemptId);
  if (direct !== undefined && invocation.attempts.has(direct)) return direct;
  // An explicit providerAttemptId/attemptIndex is authoritative; never repair a
  // bad reference by falling back to the shared recovery attemptId.
  if (reference.providerAttemptId !== undefined) return undefined;
  if (reference.attemptIndex !== undefined) {
    const matches = [...invocation.attempts.values()]
      .filter(attempt => attempt.attemptIndex === reference.attemptIndex);
    return matches.length === 1 ? matches[0]!.providerAttemptId : undefined;
  }
  if (reference.attemptId !== undefined) {
    const matches = [...invocation.attempts.values()]
      .filter(attempt => attempt.attemptResult?.attemptId === reference.attemptId);
    if (matches.length === 1) return matches[0]!.providerAttemptId;
  }
  return undefined;
}

function attemptKey(
  identity: { providerAttemptId?: string; attemptIndex?: number },
  attemptId: string | undefined,
): string | undefined {
  if (identity.providerAttemptId !== undefined) return identity.providerAttemptId;
  if (identity.attemptIndex !== undefined && attemptId !== undefined) {
    return `${attemptId}:attempt:${identity.attemptIndex}`;
  }
  return attemptId;
}

function identityFields(event: Record<string, unknown>): {
  providerAttemptId?: string; attemptIndex?: number;
} {
  return {
    providerAttemptId: stringField(event.providerAttemptId) ?? nonempty(stringField(event.provider_attempt)),
    attemptIndex: numberField(event.attemptIndex) ?? numberField(event.attempt_index),
  };
}

function attemptStatus(outcome: CallAttemptResult['outcome']): SelectionState {
  if (outcome === 'success') return 'succeeded';
  if (outcome === 'failure') return 'failed';
  if (outcome === 'skipped' || outcome === 'cancelled') return 'cancelled';
  return outcome === 'discarded' ? 'discarded' : outcome;
}

function acceptSchema(
  event: Record<string, unknown>,
  invocation: InternalInvocation,
  diagnostics: ReplayDiagnostic[],
): boolean {
  const raw = event.schemaVersion ?? event.schema_version;
  if (raw === undefined || raw === 'none') {
    diagnose(diagnostics, 'legacy_schema', invocation, 'event has no schemaVersion; replaying legacy fact');
    return true;
  }
  const schema = numberField(raw);
  if (schema === 1) return true;
  invocation.corrupt = true;
  diagnose(diagnostics, 'unsupported_schema', invocation, `schema=${String(raw)}`);
  return false;
}

function parseRequestIds(value: unknown): string[] | undefined {
  if (value === undefined || value === 'none') return undefined;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return undefined; }
  }
  if (!Array.isArray(parsed)) return undefined;
  return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

function normalizeType(value: unknown): string | undefined {
  if (value === 'llm_race_loser_cleaned') return 'race_loser_cleaned';
  if (typeof value !== 'string') return undefined;
  const type = value.startsWith('llm_call_') ? value.slice('llm_'.length) : value;
  return type === 'call_invocation_started' || type === 'call_attempt_result'
    || type === 'call_selection' || type === 'race_loser_cleaned' ? type : undefined;
}

function invocationFor(invocations: Map<string, InternalInvocation>, invocationId: string): InternalInvocation {
  let invocation = invocations.get(invocationId);
  if (invocation === undefined) {
    invocation = {
      invocationId, attempts: new Map(), selections: [], cleanups: [],
      started: false, selectionSeen: false, exhausted: false, corrupt: false,
    };
    invocations.set(invocationId, invocation);
  }
  return invocation;
}

function diagnose(
  diagnostics: ReplayDiagnostic[],
  code: string,
  invocation: { invocationId: string },
  detail: string,
  attemptId?: string,
): void {
  diagnostics.push({ code, invocationId: invocation.invocationId, ...(attemptId ? { attemptId } : {}), detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nonempty(value: string | undefined): string | undefined {
  return value === undefined || value === 'none' || value.length === 0 ? undefined : value;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}
