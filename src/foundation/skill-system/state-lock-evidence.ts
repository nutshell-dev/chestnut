import type { FileSystem } from '../fs/index.js';
import { newUuid } from '../node-utils/index.js';
import type {
  ProcessRefDecode,
  ProcessRefObservation,
} from '../process-exec/index.js';
import { SkillVersionError } from './version-types.js';

type AtomicWriteResult = ReturnType<FileSystem['writeAtomicSync']>;

export type ProcessFacts = {
  decoded?: ProcessRefDecode;
  observed?: ProcessRefObservation;
};

export type LockDecision =
  | { kind: 'retry'; reason: 'absent' }
  | { kind: 'wait'; reason: 'held' | 'unknown' | 'unsupported_version' }
  | { kind: 'takeover'; reason: 'process_gone' | 'lease_elapsed' };

export type LeaseFact = {
  source: 'at' | 'mtime';
  valueMs: number;
  observedAtMs: number;
  limitMs: number;
  /** JSON cannot represent NaN/Infinity; retain their exact category separately. */
  valueMsText?: string;
};

export type DecisionRecord = {
  version: 1;
  event: 'holder_decision';
  attemptId: string;
  sequence: number;
  atMs: number;
  lockRaw: string;
  process: ProcessFacts;
  lease?: LeaseFact;
  decision: LockDecision;
};

export type BeforeIoFailureRecord = {
  version: 1;
  event: 'observation_before_io_failure';
  attemptId: string;
  sequence: number;
  atMs: number;
  lockRaw: string;
  process: ProcessFacts;
  operation: 'stat';
  decision: 'stop';
};

type ObservationRecord = DecisionRecord | BeforeIoFailureRecord;

const OBSERVATION_DIR = 'state-lock-observations';
const MAX_DIRECTORY_CLAIMS = 3;

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/** SkillSystem-owned durable evidence; deliberately not a general logging service. */
export class StateLockObservationWriter {
  private currentAttemptId = newUuid();
  private directoryClaimed = false;
  private sequence = 0;
  private currentRecordPath: string | null = null;

  constructor(private readonly fs: FileSystem) {}

  get attemptId(): string {
    return this.currentAttemptId;
  }

  get location(): string {
    return `${OBSERVATION_DIR}/${this.currentAttemptId}`;
  }

  get lastRecordPath(): string | null {
    return this.currentRecordPath;
  }

  private failure(
    pendingRecord: ObservationRecord,
    recordPath: string,
    targetPath: string,
    error: unknown,
    writeResult?: AtomicWriteResult,
    statError?: unknown,
  ): SkillVersionError {
    const committed = writeResult !== undefined && writeResult.kind !== 'durable'
      ? ` (${writeResult.kind}; committed data must not be overwritten)`
      : '';
    return new SkillVersionError(
      'store_error',
      `State lock observation failed at ${this.location}${committed}`,
      {
        cause: {
          kind: 'state_lock_observation_persistence_failed',
          operation: pendingRecord.event === 'observation_before_io_failure' ? 'stat' : 'observation_write',
          attemptId: this.currentAttemptId,
          attemptDir: this.location,
          lockRaw: pendingRecord.lockRaw,
          processFacts: pendingRecord.process,
          pendingRecord,
          recordPath,
          targetPath,
          error,
          ...(writeResult !== undefined && { writeResult }),
          ...(pendingRecord.event === 'observation_before_io_failure' && { statError }),
        },
        evidence: [this.location],
      },
    );
  }

  private writeJson(
    targetPath: string,
    value: unknown,
    pendingRecord: ObservationRecord,
    recordPath: string,
    statError?: unknown,
  ): void {
    let content: string;
    try {
      const serialized = JSON.stringify(value) as string | undefined;
      if (serialized === undefined) throw new TypeError('State lock observation is not JSON serializable');
      content = serialized;
    } catch (error) {
      throw this.failure(pendingRecord, recordPath, targetPath, error, undefined, statError);
    }

    let result: AtomicWriteResult;
    try {
      result = this.fs.writeAtomicSync(targetPath, content);
    } catch (error) {
      throw this.failure(pendingRecord, recordPath, targetPath, error, undefined, statError);
    }
    if (result.kind !== 'durable') {
      throw this.failure(pendingRecord, recordPath, targetPath, result.error, result, statError);
    }
  }

  private persist(makeRecord: () => ObservationRecord, statError?: unknown): void {
    let record = makeRecord();
    let recordPath = `${this.location}/${String(record.sequence).padStart(6, '0')}.json`;

    if (!this.directoryClaimed) {
      let claimed = false;
      for (let claim = 0; claim < MAX_DIRECTORY_CLAIMS; claim += 1) {
        record = makeRecord();
        recordPath = `${this.location}/${String(record.sequence).padStart(6, '0')}.json`;
        try {
          this.fs.mkdirExclusiveSync(this.location);
          claimed = true;
          break;
        } catch (error) {
          if (!isEexist(error) || claim === MAX_DIRECTORY_CLAIMS - 1) {
            throw this.failure(record, recordPath, this.location, error, undefined, statError);
          }
          this.currentAttemptId = newUuid();
        }
      }
      if (!claimed) throw new Error('unreachable state lock observation directory claim state');
      this.directoryClaimed = true;

      // The sibling index fsyncs OBSERVATION_DIR, committing the attempt directory
      // entry before the first numbered record can authorize an action.
      const indexPath = `${OBSERVATION_DIR}/${this.currentAttemptId}.json`;
      this.writeJson(indexPath, {
        version: 1,
        attemptId: this.currentAttemptId,
        lockFileName: 'state.lock',
      }, record, recordPath, statError);
    }

    this.writeJson(recordPath, record, record, recordPath, statError);
    this.sequence = record.sequence;
    this.currentRecordPath = recordPath;
  }

  recordDecision(input: Omit<DecisionRecord, 'version' | 'event' | 'attemptId' | 'sequence' | 'atMs'>): void {
    this.persist(() => ({
      version: 1,
      event: 'holder_decision',
      attemptId: this.currentAttemptId,
      sequence: this.sequence + 1,
      atMs: Date.now(),
      ...input,
    }));
  }

  recordBeforeIoFailure(
    input: Omit<BeforeIoFailureRecord, 'version' | 'event' | 'attemptId' | 'sequence' | 'atMs'>,
    statError: unknown,
  ): void {
    this.persist(() => ({
      version: 1,
      event: 'observation_before_io_failure',
      attemptId: this.currentAttemptId,
      sequence: this.sequence + 1,
      atMs: Date.now(),
      ...input,
    }), statError);
  }
}
