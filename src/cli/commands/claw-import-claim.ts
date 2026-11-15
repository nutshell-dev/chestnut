import * as path from 'node:path';
import {
  captureCurrentProcessRef,
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRefCapture,
  type ProcessRefDecode,
  type ProcessRefObservation,
} from '../../foundation/process-exec/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr, newUuid, sha256Hex } from '../../foundation/node-utils/index.js';
import { CliError } from '../errors.js';

const EVIDENCE_ROOT = 'status/cli-import-claims';
const MAX_DIRECTORY_CLAIMS = 3;

type AtomicWriteResult = ReturnType<FileSystem['writeAtomicSync']>;
type PublishedState = boolean | 'unknown';

export type ImportClaimContext = {
  source: string;
  target: string;
  claimPath: string;
};

export type CapturedImportHolder = Extract<ProcessRefCapture, { kind: 'captured' }>;

export type ImportClaimV1 = {
  schema_version: 1;
  token: string;
  createdAt: string;
  source: string;
  target: string;
  manifestHash?: string;
  holder: CapturedImportHolder;
};

export type ImportClaim = {
  schema_version?: 1;
  token: string;
  createdAt: string;
  source: string;
  target: string;
  manifestHash?: string;
  pid?: number;
  process_start_time?: string;
  holder?: {
    kind: 'captured';
    value: unknown;
    evidence: unknown;
  };
};

export type ImportClaimSnapshot = {
  claim: ImportClaim;
  raw: string;
  hash: string;
};

export type ImportClaimPhase = 'claimed' | 'publishing';

export type ImportRecoveryRecord = {
  version: 1;
  claimPath: string;
  oldToken: string;
  oldHash: string;
  expectedPhase: ImportClaimPhase;
  recoveryToken: string;
  observedAt: string;
  sourceHash: string;
  targetHash: string;
  manifestHash: string | null;
};

export type ImportClaimEvent = Record<string, unknown> & {
  version: 1;
  attemptId: string;
  sequence: number;
  time: string;
  source: string;
  target: string;
  claimPath: string;
  kind: string;
};

export type HolderFacts = {
  raw: string;
  decoded?: ProcessRefDecode;
  observed?: ProcessRefObservation;
  observationError?: unknown;
  decision: 'retain' | 'eligible';
};

export type ImportClaimStateErrorOptions = {
  context: ImportClaimContext;
  stage: string;
  evidencePath?: string;
  pendingEvent?: ImportClaimEvent;
  originalError?: unknown;
  persistenceError?: unknown;
  atomicResult?: AtomicWriteResult;
  published?: PublishedState;
};

/** A fail-closed import error that retains all facts available at the failure. */
export class ImportClaimStateError extends CliError {
  readonly context: ImportClaimContext;
  readonly stage: string;
  readonly evidencePath?: string;
  readonly pendingEvent?: ImportClaimEvent;
  readonly originalError?: unknown;
  readonly persistenceError?: unknown;
  readonly atomicResult?: AtomicWriteResult;
  readonly published: PublishedState;

  constructor(message: string, options: ImportClaimStateErrorOptions) {
    super(message, { cause: options.originalError ?? options.persistenceError });
    this.name = 'ImportClaimStateError';
    this.context = options.context;
    this.stage = options.stage;
    this.evidencePath = options.evidencePath;
    this.pendingEvent = options.pendingEvent;
    this.originalError = options.originalError;
    this.persistenceError = options.persistenceError;
    this.atomicResult = options.atomicResult;
    this.published = options.published ?? false;
  }
}

type AppendOptions = {
  originalError?: unknown;
  published?: PublishedState;
};

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/** Sync a directory entry and every ancestor up to the FileSystem root. */
export function syncImportDirectoryChain(fs: FileSystem, directory: string): void {
  let current = directory === '' ? '.' : directory;
  while (true) {
    fs.syncSync(current);
    if (current === '.') return;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Create (or reuse) a directory, then fail closed unless its full ancestor chain is durable. */
export function ensureImportDirectoryDurable(
  fs: FileSystem,
  directory: string,
): { created: boolean; firstCreated?: string } {
  let firstCreated: string | undefined;
  try {
    firstCreated = fs.mkdirExclusiveSync(directory);
  } catch (error) {
    if (!isEexist(error)) throw error;
  }
  syncImportDirectoryChain(fs, directory);
  return { created: firstCreated !== undefined, ...(firstCreated !== undefined ? { firstCreated } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Durable, CLI-private operation facts for one directory-import attempt. */
export class ImportClaimEvidenceStore {
  private attemptId = newUuid();
  private directoryClaimed = false;
  private sequence = 0;

  constructor(
    private readonly fs: FileSystem,
    readonly context: ImportClaimContext,
  ) {}

  get location(): string {
    return `${EVIDENCE_ROOT}/${this.attemptId}`;
  }

  private makeEvent(kind: string, facts: Record<string, unknown>): ImportClaimEvent {
    return {
      ...facts,
      version: 1,
      attemptId: this.attemptId,
      sequence: this.sequence + 1,
      time: new Date().toISOString(),
      source: this.context.source,
      target: this.context.target,
      claimPath: this.context.claimPath,
      kind,
    };
  }

  private failure(
    stage: string,
    targetPath: string,
    pendingEvent: ImportClaimEvent,
    persistenceError: unknown,
    options: AppendOptions,
    atomicResult?: AtomicWriteResult,
  ): ImportClaimStateError {
    const committed = atomicResult !== undefined
      ? ` (${atomicResult.kind}; committed data must not be overwritten)`
      : '';
    return new ImportClaimStateError(
      `Import claim evidence persistence failed during ${stage} at ${targetPath}${committed}; `
        + `refusing to continue (claim: ${this.context.claimPath}, evidence: ${this.location})`,
      {
        context: this.context,
        stage,
        evidencePath: this.location,
        pendingEvent,
        originalError: options.originalError,
        persistenceError,
        atomicResult,
        published: options.published,
      },
    );
  }

  private writeJson(
    stage: 'write_index' | 'write_event',
    targetPath: string,
    value: unknown,
    pendingEvent: ImportClaimEvent,
    options: AppendOptions,
  ): void {
    let content: string;
    try {
      const serialized = JSON.stringify(value) as string | undefined;
      if (serialized === undefined) throw new TypeError('Import claim event is not JSON serializable');
      content = serialized;
    } catch (error) {
      throw this.failure(stage, targetPath, pendingEvent, error, options);
    }

    let result: AtomicWriteResult;
    try {
      result = this.fs.writeAtomicSync(targetPath, content);
    } catch (error) {
      throw this.failure(stage, targetPath, pendingEvent, error, options);
    }
    if (result.kind !== 'durable') {
      throw this.failure(stage, targetPath, pendingEvent, result.error, options, result);
    }
  }

  append(
    kind: string,
    facts: Record<string, unknown>,
    options: AppendOptions = {},
  ): ImportClaimEvent {
    let event = this.makeEvent(kind, facts);
    let eventPath = `${this.location}/${String(event.sequence).padStart(6, '0')}.json`;

    if (!this.directoryClaimed) {
      let claimed = false;
      let firstCreated = '';
      for (let attempt = 0; attempt < MAX_DIRECTORY_CLAIMS; attempt += 1) {
        event = this.makeEvent(kind, facts);
        eventPath = `${this.location}/${String(event.sequence).padStart(6, '0')}.json`;
        try {
          firstCreated = this.fs.mkdirExclusiveSync(this.location);
          claimed = true;
          break;
        } catch (error) {
          if (!isEexist(error) || attempt === MAX_DIRECTORY_CLAIMS - 1) {
            throw this.failure('claim_directory', this.location, event, error, options);
          }
          this.attemptId = newUuid();
        }
      }
      if (!claimed) throw new Error('unreachable import evidence directory state');
      try {
        syncImportDirectoryChain(this.fs, this.location);
      } catch (error) {
        throw this.failure('claim_directory_durability', this.location, event, error, options);
      }
      this.directoryClaimed = true;
      // The sibling index commits this directory and records its ancestor barrier.
      this.writeJson('write_index', `${EVIDENCE_ROOT}/${this.attemptId}.json`, {
        version: 1,
        attemptId: this.attemptId,
        source: this.context.source,
        target: this.context.target,
        createdAt: new Date().toISOString(),
        recordDirectory: this.location,
        directory: { firstCreated, durability: 'durable' },
      }, event, options);
    }

    this.writeJson('write_event', eventPath, event, event, options);
    this.sequence = event.sequence;
    return event;
  }
}

export type ProcessReferenceOps = {
  decode: (input: unknown) => ProcessRefDecode;
  inspect: (reference: Parameters<typeof inspectProcessRef>[0]) => ProcessRefObservation;
};

const defaultProcessReferenceOps: ProcessReferenceOps = {
  decode: decodeProcessRef,
  inspect: inspectProcessRef,
};

/** Preserve the complete L1 decode/observation and derive only an eligibility decision. */
export function observeImportReference(
  raw: string,
  input: unknown,
  ops: ProcessReferenceOps = defaultProcessReferenceOps,
): HolderFacts {
  const decoded = ops.decode(input);
  if (decoded.kind !== 'decoded') return { raw, decoded, decision: 'retain' };
  try {
    const observed = ops.inspect(decoded.value);
    return {
      raw,
      decoded,
      observed,
      decision: observed.kind === 'gone' ? 'eligible' : 'retain',
    };
  } catch (observationError) {
    // silent: the caller durably records the decoded facts and original throw before rejecting.
    return { raw, decoded, observationError, decision: 'retain' };
  }
}

function validateBusinessClaim(
  value: unknown,
  context: ImportClaimContext,
): asserts value is ImportClaim {
  if (!isRecord(value)) throw new TypeError('claim must be a JSON object');
  if (typeof value.token !== 'string' || value.token.length === 0) {
    throw new TypeError('claim token is missing or invalid');
  }
  if (typeof value.createdAt !== 'string') throw new TypeError('claim createdAt is invalid');
  if (value.source !== context.source || value.target !== context.target) {
    throw new TypeError('claim source or target does not match this import');
  }
  if (hasOwn(value, 'manifestHash') && value.manifestHash !== undefined
      && typeof value.manifestHash !== 'string') {
    throw new TypeError('claim manifestHash is invalid');
  }
}

function referenceInput(value: ImportClaim): unknown {
  if (hasOwn(value, 'schema_version')) {
    if (value.schema_version !== 1) {
      throw new TypeError(`unsupported import claim schema: ${String(value.schema_version)}`);
    }
    const holder = value.holder;
    if (!isRecord(holder) || holder.kind !== 'captured'
        || !hasOwn(holder, 'value') || !isRecord(holder.evidence)) {
      throw new TypeError('v1 import claim holder is not a complete captured reference');
    }
    return holder.value;
  }
  return {
    version: 0,
    pid: value.pid,
    ...(hasOwn(value, 'process_start_time') ? { startTime: value.process_start_time } : {}),
  };
}

/**
 * Read either claim format. Only an L1 `gone` observation can return a recovery
 * candidate; every other result is durably recorded and rejected.
 */
export function readImportClaimSnapshot(
  fs: FileSystem,
  store: ImportClaimEvidenceStore,
  claimRel: string,
  context: ImportClaimContext,
  ops: ProcessReferenceOps = defaultProcessReferenceOps,
): ImportClaimSnapshot {
  let raw: string | undefined;
  const reject = (
    reason: string,
    originalError?: unknown,
    availableFacts: Record<string, unknown> = {},
  ): never => {
    store.append('claim_read_failed', {
      ...availableFacts,
      ...(raw !== undefined ? { raw } : {}),
      reason,
    }, { originalError });
    throw new ImportClaimStateError(
      `"${context.target}" import is already in progress or was interrupted; `
        + `${reason} (claim: ${claimRel}, evidence: ${store.location}); evidence preserved`,
      {
        context,
        stage: 'read_claim',
        evidencePath: store.location,
        originalError,
        published: false,
      },
    );
  };

  let parsed: unknown;
  try {
    raw = fs.readSync(claimRel);
    parsed = JSON.parse(raw) as unknown;
    validateBusinessClaim(parsed, context);
  } catch (error) {
    // silent: the original error is attached to the typed rejection and durable event.
    return reject(formatErr(error), error);
  }

  let input: unknown;
  try {
    input = referenceInput(parsed);
  } catch (error) {
    // silent: the original error is attached to the typed rejection and durable event.
    return reject(formatErr(error), error);
  }

  let facts: HolderFacts;
  try {
    facts = observeImportReference(raw, input, ops);
  } catch (error) {
    // silent: the original error is attached to the typed rejection and durable event.
    return reject(`holder observation failed: ${formatErr(error)}`, error);
  }
  if (facts.observationError !== undefined) {
    return reject(
      `holder observation failed: ${formatErr(facts.observationError)}`,
      facts.observationError,
      { decoded: facts.decoded },
    );
  }
  store.append('holder_observed', facts);
  if (facts.decision !== 'eligible') {
    throw new ImportClaimStateError(
      `"${context.target}" import is already in progress or was interrupted; `
        + `holder is not proven gone (claim: ${claimRel}, evidence: ${store.location}); evidence preserved`,
      {
        context,
        stage: 'observe_holder',
        evidencePath: store.location,
        published: false,
      },
    );
  }
  return { claim: parsed, raw, hash: sha256Hex(raw) };
}

/** Compatibility wrapper for callers that only need the validated claim. */
export function readImportClaim(
  fs: FileSystem,
  store: ImportClaimEvidenceStore,
  claimRel: string,
  context: ImportClaimContext,
  ops: ProcessReferenceOps = defaultProcessReferenceOps,
): ImportClaim {
  return readImportClaimSnapshot(fs, store, claimRel, context, ops).claim;
}

/** Compare recovery records without requiring a new observation timestamp on replay. */
function isSameRecoveryRecord(value: unknown, expected: ImportRecoveryRecord): value is ImportRecoveryRecord {
  if (!isRecord(value)) return false;
  return value.version === expected.version
    && value.claimPath === expected.claimPath
    && value.oldToken === expected.oldToken
    && value.oldHash === expected.oldHash
    && value.expectedPhase === expected.expectedPhase
    && value.recoveryToken === expected.recoveryToken
    && typeof value.observedAt === 'string'
    && value.sourceHash === expected.sourceHash
    && value.targetHash === expected.targetHash
    && value.manifestHash === expected.manifestHash;
}

/**
 * Exclusive, content-addressed recovery CAS. The record is the single-winner
 * arbitration point for (oldToken, oldHash, expectedPhase); an unknown outcome
 * never authorizes a second record write or a claim overwrite.
 */
export function recoverImportClaim(
  claimFs: FileSystem,
  recoveryFs: FileSystem,
  store: ImportClaimEvidenceStore,
  claimRel: string,
  snapshot: ImportClaimSnapshot,
  expectedPhase: ImportClaimPhase,
  recoveryToken: string,
): ImportRecoveryRecord {
  const context = store.context;
  const oldHash = sha256Hex(snapshot.raw);
  const record: ImportRecoveryRecord = {
    version: 1,
    claimPath: context.claimPath,
    oldToken: snapshot.claim.token,
    oldHash,
    expectedPhase,
    recoveryToken,
    observedAt: new Date().toISOString(),
    sourceHash: sha256Hex(snapshot.claim.source),
    targetHash: sha256Hex(snapshot.claim.target),
    manifestHash: snapshot.claim.manifestHash ?? null,
  };
  const recoveryRoot = 'status/cli-import-recovery';
  const recordRel = `${recoveryRoot}/${oldHash}.json`;
  const facts = { ...record, oldRaw: snapshot.raw };

  const fail = (
    stage: string,
    kind: string,
    error: unknown,
    extra: Record<string, unknown> = {},
  ): never => {
    store.append(kind, { ...facts, ...extra, error: formatErr(error) }, { originalError: error });
    throw new ImportClaimStateError(
      `Import recovery could not prove exclusive ownership during ${stage}; `
        + `claim and evidence preserved (claim: ${claimRel}, evidence: ${store.location})`,
      {
        context,
        stage,
        evidencePath: store.location,
        originalError: error,
        published: false,
      },
    );
  };

  store.append('recovery_cas_requested', facts);
  const actualPhase: ImportClaimPhase = snapshot.claim.manifestHash === undefined ? 'claimed' : 'publishing';
  if (actualPhase !== expectedPhase) {
    return fail(
      'recovery_phase',
      'recovery_cas_failed',
      new Error(`expected phase ${expectedPhase}, actual ${actualPhase}`),
      { outcome: 'conflict', actualPhase },
    );
  }
  let directory: { created: boolean; firstCreated?: string };
  try {
    directory = ensureImportDirectoryDurable(recoveryFs, recoveryRoot);
  } catch (error) {
    // silent: the typed failure below preserves the original error and evidence
    return fail('recovery_directory', 'recovery_cas_failed', error, { outcome: 'unknown' });
  }
  store.append('recovery_directory_durable', { ...facts, directory });

  let created = false;
  try {
    recoveryFs.writeExclusiveSync(recordRel, JSON.stringify(record, null, 2));
    created = true;
  } catch (error) {
    // silent: exclusive-create collision is reconciled below; other errors are returned
    if (!isEexist(error)) {
      return fail('recovery_cas', 'recovery_cas_unknown', error, { outcome: 'unknown' });
    }
  }

  let committed = record;
  if (!created) {
    let existingRaw: string;
    let existing: unknown;
    try {
      existingRaw = recoveryFs.readSync(recordRel);
      existing = JSON.parse(existingRaw) as unknown;
    } catch (error) {
      // silent: read/parse failures become typed unknown evidence
      return fail('recovery_cas_read', 'recovery_cas_unknown', error, { outcome: 'unknown' });
    }
    if (!isSameRecoveryRecord(existing, record)) {
      let currentRaw: string | undefined;
      let currentError: unknown;
      try {
        currentRaw = claimFs.readSync(claimRel);
      } catch (error) {
        // silent: currentError is appended to evidence and thrown below
        currentError = error;
      }
      store.append('recovery_cas_lost', {
        ...facts,
        existing,
        ...(currentRaw !== undefined ? { currentRaw } : {}),
        ...(currentError !== undefined ? { currentError: formatErr(currentError) } : {}),
      }, { originalError: currentError });
      throw new ImportClaimStateError(
        `Import recovery was won by another token or its CAS record is invalid; `
          + `this claim was not overwritten (claim: ${claimRel}, evidence: ${store.location})`,
        {
          context,
          stage: 'recovery_cas_lost',
          evidencePath: store.location,
          originalError: currentError,
          published: false,
        },
      );
    }
    committed = existing;
  }

  try {
    // writeExclusiveSync fsyncs the file; this barrier commits its directory entry.
    syncImportDirectoryChain(recoveryFs, recoveryRoot);
  } catch (error) {
    // silent: durability failure is returned as typed unknown with evidence
    return fail('recovery_cas_durability', 'recovery_cas_unknown', error, {
      outcome: 'unknown', committed: true,
    });
  }
  store.append(created ? 'recovery_cas_won' : 'recovery_cas_replayed', { ...facts, record: committed });

  // The lock arbitrates cooperating recoverers; recheck the exact basis before
  // allowing the caller to replace the old claim. Same-token replay may observe
  // the already replaced claim, but never a different token or manifest.
  let currentRaw: string;
  try {
    currentRaw = claimFs.readSync(claimRel);
  } catch (error) {
    // silent: basis read failure is returned as typed unknown with evidence
    return fail('recovery_basis_read', 'recovery_cas_unknown', error, { outcome: 'unknown' });
  }
  if (currentRaw !== snapshot.raw) {
    let current: ImportClaim | undefined;
    try {
      const parsed = JSON.parse(currentRaw) as unknown;
      validateBusinessClaim(parsed, context);
      current = parsed;
    } catch (error) {
      // silent: malformed replacement bytes are preserved and rejected below
      return fail('recovery_basis_changed', 'recovery_cas_lost', error, { currentRaw });
    }
    const sameReplay = current.token === recoveryToken
      && current.manifestHash === snapshot.claim.manifestHash
      && current.source === snapshot.claim.source
      && current.target === snapshot.claim.target;
    if (!sameReplay) {
      store.append('recovery_cas_lost', { ...facts, currentRaw });
      throw new ImportClaimStateError(
        `Import recovery basis changed before takeover; claim was not overwritten `
          + `(claim: ${claimRel}, evidence: ${store.location})`,
        { context, stage: 'recovery_basis_changed', evidencePath: store.location, published: false },
      );
    }
  }
  return committed;
}

/** Capture exactly once and durably record the result before any target mutation. */
export function captureImportHolder(
  store: ImportClaimEvidenceStore,
  capture: () => ProcessRefCapture = captureCurrentProcessRef,
): CapturedImportHolder {
  let result: ProcessRefCapture;
  try {
    result = capture();
  } catch (error) {
    // A thrown capture has no ProcessRefCapture to invent or persist as a result.
    store.append('self_capture', {
      outcome: 'throw',
      error: formatErr(error),
    }, { originalError: error });
    throw new ImportClaimStateError(
      `Import holder identity capture threw; refusing to start target mutation `
        + `(claim: ${store.context.claimPath}, evidence: ${store.location})`,
      {
        context: store.context,
        stage: 'capture',
        evidencePath: store.location,
        originalError: error,
        published: false,
      },
    );
  }
  const event = store.append('self_capture', { capture: result });
  if (result.kind !== 'captured') {
    throw new ImportClaimStateError(
      `Import holder identity unavailable (${result.kind}); refusing to start target mutation `
        + `(claim: ${store.context.claimPath}, evidence: ${store.location})`,
      {
        context: store.context,
        stage: 'capture',
        evidencePath: store.location,
        pendingEvent: event,
        published: false,
      },
    );
  }
  return result;
}

/** Persist exact claim bytes around the atomic write and require durability. */
export function writeImportClaim(
  fs: FileSystem,
  store: ImportClaimEvidenceStore,
  claimRel: string,
  claim: ImportClaimV1,
): string {
  const context = store.context;
  let raw: string;
  try {
    raw = JSON.stringify(claim, null, 2);
  } catch (error) {
    throw new ImportClaimStateError(
      `Import claim serialization failed (claim: ${claimRel}, evidence: ${store.location})`,
      {
        context,
        stage: 'serialize_claim',
        evidencePath: store.location,
        originalError: error,
        published: false,
      },
    );
  }
  const requested = store.append('claim_write_requested', { exactRaw: raw });
  let result: AtomicWriteResult;
  try {
    result = fs.writeAtomicSync(claimRel, raw);
  } catch (error) {
    throw new ImportClaimStateError(
      `Import claim write failed without assuming the previous bytes were replaced `
        + `(claim: ${claimRel}, evidence: ${store.location})`,
      {
        context,
        stage: 'write_claim',
        evidencePath: store.location,
        pendingEvent: requested,
        originalError: error,
        published: false,
      },
    );
  }
  if (result.kind !== 'durable') {
    throw new ImportClaimStateError(
      `Import claim durability unavailable (${result.kind}); committed data must not be overwritten `
        + `(claim: ${claimRel}, evidence: ${store.location})`,
      {
        context,
        stage: 'write_claim',
        evidencePath: store.location,
        pendingEvent: requested,
        originalError: result.error,
        atomicResult: result,
        published: false,
      },
    );
  }
  store.append('claim_written', { exactRaw: raw });
  return raw;
}
