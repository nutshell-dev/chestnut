/**
 * @module L3.SubAgent.ExecutionStore
 * Versioned execution input, full no-replace claims, events, state and outcome.
 * Disk is authoritative; in-memory writer/reference state is only a projection.
 */

import * as path from 'node:path';
import { z } from 'zod';
import {
  isFileNotFound,
  type AtomicWriteResult,
  type FileEntry,
  type FileSystem,
} from '../../foundation/fs/index.js';
import { formatErr, newUuid, sha256Hex } from '../../foundation/node-utils/index.js';
import {
  captureCurrentProcessRef,
  decodeProcessRef,
  inspectProcessRef,
  type ProcessRef,
} from '../../foundation/process-exec/index.js';
import { SUBAGENT_AUDIT_EVENTS } from './audit-events.js';
import { SUBAGENT_EXECUTION_DIR } from './constants.js';
import type {
  SubagentExecutionIdentity,
  SubagentExecutionLocation,
  SubagentExecutionOptions,
  SubagentExecutionState,
  SubagentExecutionView,
  SubagentExecutionWriteEvidence,
  SubagentFinalOutcome,
  SubagentJsonValue,
  SubagentOutcomeDocument,
  SubagentProcessCapability,
  SubagentSettlementInput,
  SubagentStopReceipt,
  SubagentTransition,
} from './execution-types.js';

const jsonValueSchema: z.ZodType<SubagentJsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

const identityFields = {
  runId: z.string().min(1),
  resultDir: z.string().min(1),
  attemptId: z.string().min(1),
  ordinal: z.number().int().positive(),
} as const;

const inputSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('subagent_execution_input'),
  runId: z.string().min(1),
  resultDir: z.string().min(1),
  input: jsonValueSchema,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAtMs: z.number().int().nonnegative(),
}).strict();

const claimSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('subagent_execution_claim'),
  ...identityFields,
  parentAttemptId: z.string().min(1).nullable(),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.object({
    kind: z.literal('captured'),
    processRef: z.string().min(1),
    target: z.object({ pid: z.number().int().positive(), startTime: z.string().min(1) }).strict(),
    evidence: jsonValueSchema,
  }).strict(),
  startBasis: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('start') }).strict(),
    z.object({ kind: z.literal('resume'), previousAttemptId: z.string().min(1) }).strict(),
  ]),
  startedAtMs: z.number().int().nonnegative(),
}).strict();

const eventSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('subagent_execution_event'),
  ...identityFields,
  sequence: z.number().int().positive(),
  state: z.enum(['prepared', 'running', 'stopping', 'settling', 'recovery_required']),
  reason: z.unknown().optional(),
  committedAtMs: z.number().int().nonnegative(),
}).strict();

const stateSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('subagent_execution_state'),
  ...identityFields,
  sequence: z.number().int().nonnegative(),
  state: z.enum(['prepared', 'running', 'stopping', 'settling', 'settled', 'recovery_required']),
  reason: z.unknown().optional(),
  updatedAtMs: z.number().int().nonnegative(),
}).strict();

const outcomeSchema = z.object({
  schema_version: z.literal(1),
  ...identityFields,
  sequence: z.number().int().positive(),
  kind: z.enum(['completed', 'interrupted', 'failed']),
  content: z.string(),
  evidenceRef: z.string().optional(),
  rawResult: jsonValueSchema.optional(),
  cause: z.unknown().optional(),
  recovery: z.enum(['none', 'shared_dependency', 'uncertain_side_effect']),
  artifacts: z.array(z.object({ kind: z.string().min(1), path: z.string().min(1) }).strict()),
  degraded: z.array(z.object({
    stage: z.enum(['event', 'state', 'outcome', 'artifact']),
    artifact: z.string().min(1),
    error: z.string(),
  }).strict()),
  committedAtMs: z.number().int().nonnegative(),
}).strict();

const stopSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal('subagent_stop_requested'),
  ...identityFields,
  stopSequence: z.number().int().positive(),
  reason: z.unknown().optional(),
  requestedAtMs: z.number().int().nonnegative(),
}).strict();

export interface SubagentExecutionInputDocument extends SubagentExecutionLocation {
  readonly schema_version: 1;
  readonly kind: 'subagent_execution_input';
  readonly input: SubagentJsonValue;
  readonly inputDigest: string;
  readonly createdAtMs: number;
}

export interface SubagentAttemptClaim extends SubagentExecutionIdentity {
  readonly schema_version: 1;
  readonly kind: 'subagent_execution_claim';
  readonly ordinal: number;
  readonly parentAttemptId: string | null;
  readonly inputDigest: string;
  readonly owner: {
    readonly kind: 'captured';
    readonly processRef: ProcessRef;
    readonly target: { readonly pid: number; readonly startTime: string };
    readonly evidence: SubagentJsonValue;
  };
  readonly startBasis: { readonly kind: 'start' } | { readonly kind: 'resume'; readonly previousAttemptId: string };
  readonly startedAtMs: number;
}

export type SubagentExecutionRead =
  | { readonly kind: 'found'; readonly input: SubagentExecutionInputDocument; readonly claim: SubagentAttemptClaim; readonly view: SubagentExecutionView }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'corrupt'; readonly path?: string; readonly reason: string };

export interface SubagentTransitionResult {
  readonly view: SubagentExecutionView;
  readonly event: SubagentExecutionWriteEvidence;
  readonly state?: SubagentExecutionWriteEvidence;
}

export type SubagentClaimResult =
  | { readonly kind: 'claimed'; readonly claim: SubagentAttemptClaim; readonly writer: SubagentAttemptWriter; readonly persistence: SubagentExecutionWriteEvidence }
  | { readonly kind: 'existing'; readonly claim: SubagentAttemptClaim };

export type SubagentExecutionErrorKind = 'corrupt' | 'io' | 'conflict' | 'not_found' | 'owner_unavailable' | 'persistence';

export class SubagentExecutionStoreError extends Error {
  constructor(
    readonly kind: SubagentExecutionErrorKind,
    message: string,
    readonly recordPath?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SubagentExecutionStoreError';
  }
}

export class SubagentOwnerUnavailableError extends SubagentExecutionStoreError {
  constructor(readonly identity: SubagentExecutionLocation, readonly detail: string, options?: { cause?: unknown }) {
    super('owner_unavailable', `subagent owner unavailable for ${identity.runId}: ${detail}`, undefined, options);
    this.name = 'SubagentOwnerUnavailableError';
  }
}

export function normalizeSubagentLocation(location: SubagentExecutionLocation): SubagentExecutionLocation {
  if (typeof location.runId !== 'string' || location.runId.trim() === '') {
    throw new SubagentExecutionStoreError('conflict', 'subagent runId must be a non-empty string');
  }
  if (typeof location.resultDir !== 'string' || location.resultDir.trim() === '') {
    throw new SubagentExecutionStoreError('conflict', 'subagent resultDir must be a non-empty string');
  }
  const normalizedDir = path.posix.normalize(location.resultDir.trim());
  const resultDir = normalizedDir.replace(/\/+$/, '');
  if (path.posix.isAbsolute(normalizedDir) || resultDir === '' || resultDir === '.' || resultDir === '..'
      || resultDir.startsWith('../') || location.resultDir.includes('\\') || location.resultDir.includes('\0')) {
    throw new SubagentExecutionStoreError('conflict', `invalid subagent resultDir: ${JSON.stringify(location.resultDir)}`);
  }
  return { runId: location.runId.trim(), resultDir };
}

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isJsonValue(value: unknown): value is SubagentJsonValue {
  const result = jsonValueSchema.safeParse(value);
  return result.success;
}

function json(value: unknown): string {
  const result = JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
    return item;
  }, 2);
  if (result === undefined) throw new TypeError('execution record is not JSON serializable');
  return result;
}

function canonicalInput(value: unknown): { input: SubagentJsonValue; serialized: string; digest: string } {
  if (!isJsonValue(value)) {
    throw new SubagentExecutionStoreError('conflict', 'subagent execution input must be a finite JSON value');
  }
  const normalize = (item: SubagentJsonValue): SubagentJsonValue => {
    if (Array.isArray(item)) return item.map(entry => normalize(entry));
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(Object.entries(item)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]));
    }
    return item;
  };
  const input = normalize(value);
  const serialized = JSON.stringify(input);
  return { input, serialized, digest: sha256Hex(serialized) };
}

function identityOf(claim: SubagentAttemptClaim): SubagentExecutionIdentity {
  return { runId: claim.runId, resultDir: claim.resultDir, attemptId: claim.attemptId };
}

function unknownEvidence(recordPath: string): SubagentExecutionWriteEvidence {
  return {
    path: recordPath,
    kind: 'unknown',
    persisted: true,
    durable: false,
    error: 'write durability evidence is unavailable when replaying a committed record',
  };
}

interface StoreOptions extends SubagentExecutionOptions {
  readonly resultDir: string;
}

type PublishResult =
  | { readonly kind: 'published'; readonly evidence: SubagentExecutionWriteEvidence }
  | { readonly kind: 'exists' };

export class SubagentExecutionStore {
  readonly resultDir: string;
  readonly executionDir: string;

  private readonly fs: FileSystem;
  private readonly process: SubagentProcessCapability;
  private readonly now: () => number;
  private readonly newAttemptId: () => string;
  private readonly auditWriter: SubagentExecutionOptions['auditWriter'];
  private readonly listeners = new Map<string, Set<(view: SubagentExecutionView) => void>>();

  constructor(options: StoreOptions) {
    this.resultDir = normalizeSubagentLocation({ runId: 'store', resultDir: options.resultDir }).resultDir;
    this.executionDir = path.join(this.resultDir, SUBAGENT_EXECUTION_DIR);
    this.fs = options.fs;
    this.process = options.process ?? { captureCurrentProcessRef, inspectProcessRef };
    this.now = options.now ?? Date.now;
    this.newAttemptId = options.newAttemptId ?? newUuid;
    this.auditWriter = options.auditWriter;
  }

  get inputPath(): string { return path.join(this.executionDir, 'input.json'); }

  exists(recordPath: string): Promise<boolean> { return this.fs.exists(recordPath); }
  private get attemptsDir(): string { return path.join(this.executionDir, 'attempts'); }
  private attemptDir(ordinal: number): string { return path.join(this.attemptsDir, String(ordinal)); }
  private claimPath(ordinal: number): string { return path.join(this.attemptDir(ordinal), 'claim.json'); }
  private outcomePath(ordinal: number): string { return path.join(this.attemptDir(ordinal), 'outcome.json'); }
  private statePath(ordinal: number): string { return path.join(this.attemptDir(ordinal), 'state.json'); }
  private eventPath(ordinal: number, sequence: number): string {
    return path.join(this.attemptDir(ordinal), 'events', `${sequence}.json`);
  }
  private stopPath(ordinal: number, sequence: number): string {
    return path.join(this.attemptDir(ordinal), 'stops', `${sequence}.json`);
  }

  private listenerKey(identity: SubagentExecutionIdentity): string {
    return `${identity.runId}\0${identity.attemptId}`;
  }

  subscribe(identity: SubagentExecutionIdentity, listener: (view: SubagentExecutionView) => void): () => void {
    const key = this.listenerKey(identity);
    const listeners = this.listeners.get(key) ?? new Set<(view: SubagentExecutionView) => void>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  private publish(view: SubagentExecutionView): void {
    for (const listener of [...(this.listeners.get(this.listenerKey(view.identity)) ?? [])]) listener(view);
  }

  private audit(event: string, ...columns: unknown[]): void {
    try {
      this.auditWriter?.write(event, ...columns);
    } catch (error) {
      process.stderr.write(`[subagent] execution audit failed: ${formatErr(error)}\n`);
    }
  }

  private committed(recordPath: string, identity: SubagentExecutionLocation, evidence: SubagentExecutionWriteEvidence): void {
    this.audit(
      SUBAGENT_AUDIT_EVENTS.EXECUTION_RECORD_COMMITTED,
      `runId=${identity.runId}`,
      `path=${recordPath}`,
      `kind=${evidence.kind}`,
      `durable=${evidence.durable}`,
    );
  }

  private conflict(identity: SubagentExecutionLocation, detail: string): SubagentExecutionStoreError {
    this.audit(SUBAGENT_AUDIT_EVENTS.EXECUTION_IDENTITY_CONFLICT, `runId=${identity.runId}`, `reason=${detail}`);
    return new SubagentExecutionStoreError('conflict', `subagent execution identity conflict for ${identity.runId}: ${detail}`);
  }

  private corrupt(recordPath: string, cause: unknown): SubagentExecutionStoreError {
    return new SubagentExecutionStoreError(
      'corrupt',
      `subagent execution record corrupt at ${recordPath}: ${formatErr(cause)}`,
      recordPath,
      { cause },
    );
  }

  private parse<T>(recordPath: string, raw: string, schema: z.ZodType<T>): T {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw this.corrupt(recordPath, error);
    }
    const result = schema.safeParse(value);
    if (!result.success) throw this.corrupt(recordPath, result.error);
    return result.data;
  }

  private async readRequired(recordPath: string): Promise<string> {
    try {
      return await this.fs.read(recordPath);
    } catch (error) {
      if (isFileNotFound(error)) {
        throw new SubagentExecutionStoreError('not_found', `subagent execution record missing: ${recordPath}`, recordPath, { cause: error });
      }
      throw new SubagentExecutionStoreError('io', `subagent execution record unreadable: ${recordPath}: ${formatErr(error)}`, recordPath, { cause: error });
    }
  }

  private evidence(recordPath: string, result: AtomicWriteResult): SubagentExecutionWriteEvidence {
    return {
      path: recordPath,
      kind: result.kind,
      persisted: true,
      durable: result.kind === 'durable',
      ...(result.kind === 'durable' ? {} : { error: formatErr(result.error) }),
    };
  }

  private failedEvidence(recordPath: string, error: unknown): SubagentExecutionWriteEvidence {
    return { path: recordPath, kind: 'failed', persisted: false, durable: false, error: formatErr(error) };
  }

  private async writeAtomic(recordPath: string, value: unknown, identity: SubagentExecutionIdentity): Promise<SubagentExecutionWriteEvidence> {
    let result: AtomicWriteResult;
    try {
      result = await this.fs.writeAtomic(recordPath, json(value));
    } catch (error) {
      return this.failedEvidence(recordPath, error);
    }
    const evidence = this.evidence(recordPath, result);
    this.committed(recordPath, identity, evidence);
    return evidence;
  }

  /** Complete staging is fsynced before the destination first becomes visible. */
  private async publishExclusive(recordPath: string, value: unknown): Promise<PublishResult> {
    const stagingPath = path.join(path.dirname(recordPath), `.${path.basename(recordPath)}.staging-${newUuid()}`);
    let stagingResult: AtomicWriteResult;
    try {
      stagingResult = await this.fs.writeAtomic(stagingPath, json(value));
    } catch (error) {
      throw new SubagentExecutionStoreError('persistence', `failed to stage execution record ${recordPath}: ${formatErr(error)}`, recordPath, { cause: error });
    }
    try {
      try {
        this.fs.linkExclusiveSync(stagingPath, recordPath);
      } catch (error) {
        if (isEexist(error)) return { kind: 'exists' };
        throw error;
      }
      let evidence = this.evidence(recordPath, stagingResult);
      try {
        this.fs.syncSync(path.dirname(recordPath));
        if (stagingResult.kind === 'durable') evidence = this.evidence(recordPath, { kind: 'durable' });
      } catch (error) {
        evidence = {
          path: recordPath,
          kind: 'committed_durability_unknown',
          persisted: true,
          durable: false,
          error: formatErr(error),
        };
      }
      return { kind: 'published', evidence };
    } catch (error) {
      if (error instanceof SubagentExecutionStoreError) throw error;
      throw new SubagentExecutionStoreError('persistence', `failed to publish execution record ${recordPath}: ${formatErr(error)}`, recordPath, { cause: error });
    } finally {
      try {
        await this.fs.delete(stagingPath);
      } catch {
        // silent: staging has no authority; preserve the publish result/original failure.
      }
    }
  }

  private parseInput(raw: string, expectedRunId: string): SubagentExecutionInputDocument {
    const document = this.parse(this.inputPath, raw, inputSchema);
    if (document.runId !== expectedRunId || document.resultDir !== this.resultDir) {
      throw this.corrupt(this.inputPath, new Error('input identity does not match its normalized location'));
    }
    const canonical = canonicalInput(document.input);
    if (canonical.digest !== document.inputDigest) throw this.corrupt(this.inputPath, new Error('input digest mismatch'));
    return document;
  }

  async prepareInput(location: SubagentExecutionLocation, input: unknown): Promise<{
    document: SubagentExecutionInputDocument;
    persistence?: SubagentExecutionWriteEvidence;
  }> {
    const normalized = normalizeSubagentLocation(location);
    if (normalized.resultDir !== this.resultDir) {
      throw this.conflict(normalized, `store owns ${this.resultDir}, not ${normalized.resultDir}`);
    }
    const canonical = canonicalInput(input);
    const document: SubagentExecutionInputDocument = {
      schema_version: 1,
      kind: 'subagent_execution_input',
      ...normalized,
      input: canonical.input,
      inputDigest: canonical.digest,
      createdAtMs: this.now(),
    };
    const published = await this.publishExclusive(this.inputPath, document);
    if (published.kind === 'published') {
      this.committed(this.inputPath, normalized, published.evidence);
      return { document, persistence: published.evidence };
    }
    const existing = this.parseInput(await this.readRequired(this.inputPath), normalized.runId);
    if (existing.inputDigest !== canonical.digest || JSON.stringify(existing.input) !== canonical.serialized) {
      throw this.conflict(normalized, `input differs from ${this.inputPath}`);
    }
    return { document: existing };
  }

  private parseClaim(ordinal: number, raw: string): SubagentAttemptClaim {
    const recordPath = this.claimPath(ordinal);
    const document = this.parse(recordPath, raw, claimSchema);
    if (document.ordinal !== ordinal || document.resultDir !== this.resultDir) {
      throw this.corrupt(recordPath, new Error('claim identity does not match its path'));
    }
    const decoded = decodeProcessRef(document.owner.processRef);
    if (decoded.kind !== 'decoded') throw this.corrupt(recordPath, new Error(`invalid owner ProcessRef: ${decoded.kind}`));
    return { ...document, owner: { ...document.owner, processRef: decoded.value } };
  }

  private async listOrdinals(): Promise<number[]> {
    let entries;
    try {
      entries = await this.fs.list(this.attemptsDir, { includeDirs: true });
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw new SubagentExecutionStoreError('io', `cannot list execution attempts: ${formatErr(error)}`, this.attemptsDir, { cause: error });
    }
    const ordinals: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (!/^[1-9]\d*$/.test(entry.name)) throw this.corrupt(this.attemptsDir, new Error(`invalid attempt ordinal ${entry.name}`));
      const ordinal = Number(entry.name);
      if (!Number.isSafeInteger(ordinal)) throw this.corrupt(this.attemptsDir, new Error(`unsafe attempt ordinal ${entry.name}`));
      ordinals.push(ordinal);
    }
    return ordinals.sort((left, right) => left - right);
  }

  private async readClaimAt(ordinal: number): Promise<SubagentAttemptClaim> {
    return this.parseClaim(ordinal, await this.readRequired(this.claimPath(ordinal)));
  }

  private async readOutcome(claim: SubagentAttemptClaim): Promise<SubagentOutcomeDocument | undefined> {
    const recordPath = this.outcomePath(claim.ordinal);
    let raw: string;
    try {
      raw = await this.fs.read(recordPath);
    } catch (error) {
      if (isFileNotFound(error)) return undefined;
      throw new SubagentExecutionStoreError('io', `outcome unreadable: ${formatErr(error)}`, recordPath, { cause: error });
    }
    const outcome = this.parse(recordPath, raw, outcomeSchema);
    if (outcome.runId !== claim.runId || outcome.resultDir !== claim.resultDir
        || outcome.attemptId !== claim.attemptId || outcome.ordinal !== claim.ordinal) {
      throw this.corrupt(recordPath, new Error('outcome identity does not match claim'));
    }
    return outcome;
  }

  private async project(claim: SubagentAttemptClaim): Promise<SubagentExecutionView> {
    const identity = identityOf(claim);
    const outcome = await this.readOutcome(claim);
    let sequence = 0;
    let state: SubagentExecutionState = 'prepared';
    let reason: unknown;
    let entries: FileEntry[];
    const eventsDir = path.join(this.attemptDir(claim.ordinal), 'events');
    try {
      entries = await this.fs.list(eventsDir);
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw new SubagentExecutionStoreError('io', `events unreadable: ${formatErr(error)}`, eventsDir, { cause: error });
      }
      entries = [];
    }
    const eventFiles = entries.filter(entry => entry.isFile && /^\d+\.json$/.test(entry.name));
    eventFiles.sort((left, right) => Number(left.name.slice(0, -5)) - Number(right.name.slice(0, -5)));
    for (let index = 0; index < eventFiles.length; index += 1) {
      const entry = eventFiles[index];
      const eventSequence = Number(entry.name.slice(0, -5));
      if (eventSequence !== index + 1) throw this.corrupt(eventsDir, new Error(`event sequence gap at ${index + 1}`));
      const eventPath = path.join(eventsDir, entry.name);
      const event = this.parse(eventPath, await this.readRequired(eventPath), eventSchema);
      if (event.runId !== claim.runId || event.resultDir !== claim.resultDir
          || event.attemptId !== claim.attemptId || event.ordinal !== claim.ordinal
          || event.sequence !== eventSequence) {
        throw this.corrupt(eventPath, new Error('event identity or sequence does not match claim/path'));
      }
      if (outcome && eventSequence >= outcome.sequence) {
        throw this.corrupt(eventPath, new Error('an event overlaps or follows the terminal outcome'));
      }
      sequence = event.sequence;
      state = event.state;
      reason = event.reason;
    }
    if (!outcome) return { identity, ordinal: claim.ordinal, sequence, state, ...(reason !== undefined ? { reason } : {}) };
    if (outcome.sequence !== sequence + 1) {
      throw this.corrupt(this.outcomePath(claim.ordinal), new Error('outcome sequence is not the next transition'));
    }
    const final: SubagentFinalOutcome = {
      identity,
      kind: outcome.kind,
      content: outcome.content,
      ...(outcome.evidenceRef !== undefined ? { evidenceRef: outcome.evidenceRef } : {}),
      ...(outcome.rawResult !== undefined ? { rawResult: outcome.rawResult } : {}),
      ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      recovery: outcome.recovery,
      artifacts: outcome.artifacts,
      degraded: outcome.degraded,
      persistence: {
        executionDir: this.executionDir,
        outcome: unknownEvidence(this.outcomePath(claim.ordinal)),
        events: [],
        stops: [],
      },
    };
    return { identity, ordinal: claim.ordinal, sequence: outcome.sequence, state: 'settled', outcome: final };
  }

  /** Strict latest-attempt read. Existing execution metadata without a claim is corrupt, not legacy. */
  async read(runId: string, attemptId?: string): Promise<SubagentExecutionRead> {
    let normalized: SubagentExecutionLocation;
    try {
      normalized = normalizeSubagentLocation({ runId, resultDir: this.resultDir });
      if (!(await this.fs.exists(this.executionDir))) return { kind: 'not_found' };
      const input = this.parseInput(await this.readRequired(this.inputPath), normalized.runId);
      const ordinals = await this.listOrdinals();
      if (ordinals.length === 0) throw this.corrupt(this.attemptsDir, new Error('execution input exists without an attempt claim'));
      let selected: SubagentAttemptClaim | undefined;
      for (const ordinal of ordinals) {
        const claim = await this.readClaimAt(ordinal);
        if (claim.runId !== normalized.runId || claim.inputDigest !== input.inputDigest) {
          throw this.corrupt(this.claimPath(ordinal), new Error('claim runId/input digest does not match input.json'));
        }
        if (attemptId !== undefined && claim.attemptId === attemptId) selected = claim;
      }
      if (attemptId === undefined) selected = await this.readClaimAt(ordinals[ordinals.length - 1]);
      if (!selected) return { kind: 'not_found' };
      return { kind: 'found', input, claim: selected, view: await this.project(selected) };
    } catch (error) {
      if (error instanceof SubagentExecutionStoreError && error.kind === 'not_found') return { kind: 'not_found' };
      if (error instanceof SubagentExecutionStoreError && (error.kind === 'corrupt' || error.kind === 'io')) {
        return { kind: 'corrupt', ...(error.recordPath ? { path: error.recordPath } : {}), reason: error.message };
      }
      throw error;
    }
  }

  async readView(identity: SubagentExecutionIdentity): Promise<SubagentExecutionView> {
    const read = await this.read(identity.runId, identity.attemptId);
    if (read.kind === 'found') return read.view;
    if (read.kind === 'not_found') {
      throw new SubagentExecutionStoreError('not_found', `subagent execution not found: ${identity.runId}/${identity.attemptId}`);
    }
    throw new SubagentExecutionStoreError('corrupt', read.reason, read.path);
  }

  async latestClaim(runId: string): Promise<SubagentAttemptClaim | undefined> {
    normalizeSubagentLocation({ runId, resultDir: this.resultDir });
    const ordinals = await this.listOrdinals();
    if (ordinals.length === 0) return undefined;
    const claim = await this.readClaimAt(ordinals[ordinals.length - 1]);
    if (claim.runId !== runId.trim()) throw this.corrupt(this.claimPath(claim.ordinal), new Error('latest claim runId mismatch'));
    return claim;
  }

  inspectOwner(claim: SubagentAttemptClaim): ReturnType<SubagentProcessCapability['inspectProcessRef']> {
    return this.process.inspectProcessRef(claim.owner.processRef);
  }

  async claimAttempt(input: {
    readonly location: SubagentExecutionLocation;
    readonly inputDigest: string;
    readonly ordinal: number;
    readonly parentAttemptId: string | null;
    readonly startBasis: 'start' | 'resume';
  }): Promise<SubagentClaimResult> {
    const location = normalizeSubagentLocation(input.location);
    const capture = this.process.captureCurrentProcessRef();
    if (capture.kind !== 'captured') {
      const detail = capture.kind === 'gone'
        ? `current host process capture returned gone (${formatErr(capture.evidence)})`
        : `current host process capture returned ${capture.kind}/${capture.reason} (${formatErr(capture.evidence)})`;
      throw new SubagentOwnerUnavailableError(location, detail);
    }
    if (!isJsonValue(capture.evidence)) {
      throw new SubagentOwnerUnavailableError(location, 'captured ProcessRef evidence is not JSON serializable');
    }
    if (typeof capture.target.startTime !== 'string' || capture.target.startTime.length === 0) {
      throw new SubagentOwnerUnavailableError(location, 'captured ProcessRef has no verified startTime');
    }
    const claim: SubagentAttemptClaim = {
      schema_version: 1,
      kind: 'subagent_execution_claim',
      ...location,
      ordinal: input.ordinal,
      attemptId: this.newAttemptId(),
      parentAttemptId: input.parentAttemptId,
      inputDigest: input.inputDigest,
      owner: {
        kind: 'captured',
        processRef: capture.value,
        target: { pid: capture.target.pid, startTime: capture.target.startTime },
        evidence: capture.evidence,
      },
      startBasis: input.startBasis === 'start'
        ? { kind: 'start' }
        : { kind: 'resume', previousAttemptId: input.parentAttemptId ?? '' },
      startedAtMs: this.now(),
    };
    const parsed = claimSchema.safeParse(claim);
    if (!parsed.success) throw this.conflict(location, `invalid new claim: ${formatErr(parsed.error)}`);
    const published = await this.publishExclusive(this.claimPath(input.ordinal), claim);
    if (published.kind === 'exists') {
      const existing = await this.readClaimAt(input.ordinal);
      if (existing.runId !== location.runId || existing.inputDigest !== input.inputDigest
          || existing.parentAttemptId !== input.parentAttemptId) {
        throw this.conflict(location, `different claim already owns ordinal ${input.ordinal}`);
      }
      return { kind: 'existing', claim: existing };
    }
    this.committed(this.claimPath(input.ordinal), location, published.evidence);
    return {
      kind: 'claimed',
      claim,
      persistence: published.evidence,
      writer: new SubagentAttemptWriter(this, claim, published.evidence),
    };
  }

  async transition(claim: SubagentAttemptClaim, sequence: number, change: SubagentTransition): Promise<SubagentTransitionResult> {
    const identity = identityOf(claim);
    const eventPath = this.eventPath(claim.ordinal, sequence);
    const event = {
      schema_version: 1,
      kind: 'subagent_execution_event',
      ...identity,
      ordinal: claim.ordinal,
      sequence,
      state: change.state,
      ...(change.reason !== undefined ? { reason: change.reason } : {}),
      committedAtMs: this.now(),
    };
    let eventEvidence: SubagentExecutionWriteEvidence;
    try {
      const published = await this.publishExclusive(eventPath, event);
      if (published.kind === 'exists') throw new Error('event already exists; refusing to replace it');
      eventEvidence = published.evidence;
    } catch (error) {
      // silent: the original failure is returned as typed non-persisted event evidence.
      eventEvidence = this.failedEvidence(eventPath, error);
      return { view: await this.project(claim), event: eventEvidence };
    }
    this.committed(eventPath, identity, eventEvidence);
    const view: SubagentExecutionView = {
      identity,
      ordinal: claim.ordinal,
      sequence,
      state: change.state,
      ...(change.reason !== undefined ? { reason: change.reason } : {}),
    };
    const state = {
      schema_version: 1,
      kind: 'subagent_execution_state',
      ...identity,
      ordinal: claim.ordinal,
      sequence,
      state: change.state,
      ...(change.reason !== undefined ? { reason: change.reason } : {}),
      updatedAtMs: this.now(),
    };
    const validated = stateSchema.safeParse(state);
    const stateEvidence = validated.success
      ? await this.writeAtomic(this.statePath(claim.ordinal), state, identityOf(claim))
      : this.failedEvidence(this.statePath(claim.ordinal), validated.error);
    this.publish(view);
    return { view, event: eventEvidence, state: stateEvidence };
  }

  async stop(claim: SubagentAttemptClaim, stopSequence: number, reason: unknown): Promise<SubagentExecutionWriteEvidence> {
    const recordPath = this.stopPath(claim.ordinal, stopSequence);
    const record = {
      schema_version: 1,
      kind: 'subagent_stop_requested',
      ...identityOf(claim),
      ordinal: claim.ordinal,
      stopSequence,
      ...(reason !== undefined ? { reason } : {}),
      requestedAtMs: this.now(),
    };
    const validated = stopSchema.safeParse(record);
    if (!validated.success) return this.failedEvidence(recordPath, validated.error);
    try {
      const published = await this.publishExclusive(recordPath, record);
      if (published.kind === 'exists') throw new Error('stop record already exists; refusing to replace it');
      this.committed(recordPath, identityOf(claim), published.evidence);
      return published.evidence;
    } catch (error) {
      return this.failedEvidence(recordPath, error);
    }
  }

  async outcome(claim: SubagentAttemptClaim, document: SubagentOutcomeDocument): Promise<{
    readonly document: SubagentOutcomeDocument;
    readonly evidence: SubagentExecutionWriteEvidence;
    readonly state: SubagentExecutionWriteEvidence;
  }> {
    const recordPath = this.outcomePath(claim.ordinal);
    let committedDocument = document;
    let evidence: SubagentExecutionWriteEvidence;
    try {
      const published = await this.publishExclusive(recordPath, document);
      if (published.kind === 'exists') {
        committedDocument = await this.readOutcome(claim) ?? (() => {
          throw new Error('outcome no-replace race left no readable outcome');
        })();
        evidence = unknownEvidence(recordPath);
      } else {
        evidence = published.evidence;
      }
    } catch (error) {
      // silent: the original failure is returned as typed non-persisted outcome evidence.
      evidence = this.failedEvidence(recordPath, error);
      return { document, evidence, state: this.failedEvidence(this.statePath(claim.ordinal), error) };
    }
    this.committed(recordPath, identityOf(claim), evidence);
    const state = {
      schema_version: 1,
      kind: 'subagent_execution_state',
      ...identityOf(claim),
      ordinal: claim.ordinal,
      sequence: committedDocument.sequence,
      state: 'settled',
      updatedAtMs: this.now(),
    };
    const validated = stateSchema.safeParse(state);
    const stateEvidence = validated.success
      ? await this.writeAtomic(this.statePath(claim.ordinal), state, identityOf(claim))
      : this.failedEvidence(this.statePath(claim.ordinal), validated.error);
    return { document: committedDocument, evidence, state: stateEvidence };
  }

  recoveryView(view: SubagentExecutionView, outcome: SubagentFinalOutcome): void {
    this.publish({ ...view, state: 'recovery_required', outcome });
  }

  settledView(view: SubagentExecutionView): void {
    this.publish(view);
  }

  finalFromOutcome(
    claim: SubagentAttemptClaim,
    outcome: SubagentOutcomeDocument,
    outcomeEvidence: SubagentExecutionWriteEvidence,
    events: readonly SubagentExecutionWriteEvidence[],
    stops: readonly SubagentExecutionWriteEvidence[],
    stateEvidence?: SubagentExecutionWriteEvidence,
  ): SubagentFinalOutcome {
    return {
      identity: identityOf(claim),
      kind: outcome.kind,
      content: outcome.content,
      ...(outcome.evidenceRef !== undefined ? { evidenceRef: outcome.evidenceRef } : {}),
      ...(outcome.rawResult !== undefined ? { rawResult: outcome.rawResult } : {}),
      ...(outcome.cause !== undefined ? { cause: outcome.cause } : {}),
      recovery: outcome.recovery,
      artifacts: outcome.artifacts,
      degraded: outcome.degraded,
      persistence: {
        executionDir: this.executionDir,
        outcome: outcomeEvidence,
        ...(stateEvidence ? { state: stateEvidence } : {}),
        events: [...events],
        stops: [...stops],
      },
    };
  }
}

/** Owner-only write capability. A read/open operation cannot construct one. */
export class SubagentAttemptWriter {
  private sequence = 0;
  private stopSequence = 0;
  private operation: Promise<unknown> = Promise.resolve();
  private current: SubagentExecutionView;
  private final?: SubagentFinalOutcome;
  private readonly events: SubagentExecutionWriteEvidence[] = [];
  private readonly stops: SubagentExecutionWriteEvidence[] = [];

  constructor(
    private readonly store: SubagentExecutionStore,
    readonly claim: SubagentAttemptClaim,
    readonly claimPersistence: SubagentExecutionWriteEvidence,
  ) {
    this.current = {
      identity: identityOf(claim),
      ordinal: claim.ordinal,
      sequence: 0,
      state: 'prepared',
    };
  }

  get view(): SubagentExecutionView { return this.current; }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  transition(change: SubagentTransition): Promise<SubagentTransitionResult> {
    return this.enqueue(async () => {
      if (this.final) throw new SubagentExecutionStoreError('conflict', 'cannot transition an attempt after settlement');
      const result = await this.store.transition(this.claim, this.sequence + 1, change);
      if (result.event.persisted) {
        this.sequence = result.view.sequence;
        this.current = result.view;
        this.events.push(result.event);
      }
      return result;
    });
  }

  requestStop(reason: unknown): Promise<SubagentStopReceipt> {
    return this.enqueue(async () => {
      const identity = identityOf(this.claim);
      if (this.final || this.current.state === 'settled' || this.current.state === 'recovery_required') {
        return {
          identity,
          accepted: false,
          state: this.current.state,
          reason,
          persisted: false,
          durable: false,
          persistence: {
            path: path.join(this.store.executionDir, 'stops'),
            kind: 'unavailable',
            persisted: false,
            durable: false,
            error: 'attempt is already terminal or recovery-required',
          },
        };
      }
      const persistence = await this.store.stop(this.claim, ++this.stopSequence, reason);
      this.stops.push(persistence);
      const transition = await this.store.transition(this.claim, this.sequence + 1, { state: 'stopping', reason });
      let statePersistence: SubagentExecutionWriteEvidence | undefined;
      if (transition.event.persisted) {
        this.sequence = transition.view.sequence;
        this.current = transition.view;
        this.events.push(transition.event);
        statePersistence = transition.state;
      } else {
        statePersistence = transition.event;
      }
      return {
        identity,
        accepted: true,
        state: this.current.state,
        reason,
        persisted: persistence.persisted,
        durable: persistence.durable,
        persistence,
        ...(statePersistence ? { statePersistence } : {}),
      };
    });
  }

  settle(input: SubagentSettlementInput): Promise<SubagentFinalOutcome> {
    return this.enqueue(async () => {
      if (this.final) return this.final;
      const settling = await this.store.transition(this.claim, this.sequence + 1, {
        state: 'settling',
        reason: { kind: 'actual_execution_settled' },
      });
      if (settling.event.persisted) {
        this.sequence = settling.view.sequence;
        this.current = settling.view;
        this.events.push(settling.event);
      }
      const document: SubagentOutcomeDocument = {
        schema_version: 1,
        ...identityOf(this.claim),
        ordinal: this.claim.ordinal,
        sequence: this.sequence + 1,
        kind: input.kind,
        content: input.content,
        ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
        ...(input.rawResult !== undefined ? { rawResult: input.rawResult } : {}),
        ...(input.cause !== undefined ? { cause: input.cause } : {}),
        recovery: input.recovery ?? 'none',
        artifacts: input.artifacts ?? [],
        degraded: input.degraded ?? [],
        committedAtMs: Date.now(),
      };
      const written = await this.store.outcome(this.claim, document);
      if (!written.evidence.persisted) {
        const recovery = await this.store.transition(this.claim, this.sequence + 1, {
          state: 'recovery_required',
          reason: { kind: 'outcome_commit_failed', error: written.evidence.error ?? 'unknown' },
        });
        if (recovery.event.persisted) {
          this.sequence = recovery.view.sequence;
          this.current = recovery.view;
          this.events.push(recovery.event);
        }
        const failedDocument: SubagentOutcomeDocument = {
          ...document,
          degraded: [...document.degraded, {
            stage: 'outcome',
            artifact: written.evidence.path,
            error: written.evidence.error ?? 'outcome commit failed',
          }],
        };
        const final = this.store.finalFromOutcome(
          this.claim,
          failedDocument,
          written.evidence,
          this.events,
          this.stops,
          recovery.state,
        );
        this.final = final;
        this.store.recoveryView(this.current, final);
        return final;
      }
      this.sequence = written.document.sequence;
      const final = this.store.finalFromOutcome(
        this.claim,
        written.document,
        written.evidence,
        this.events,
        this.stops,
        written.state,
      );
      this.final = final;
      this.current = {
        identity: identityOf(this.claim),
        ordinal: this.claim.ordinal,
        sequence: this.sequence,
        state: 'settled',
        outcome: final,
      };
      this.store.settledView(this.current);
      return final;
    });
  }
}

export function createSubagentExecutionStore(options: StoreOptions): SubagentExecutionStore {
  return new SubagentExecutionStore(options);
}
