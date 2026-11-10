import type { FileSystem } from '../fs/index.js';
import { newUuid } from '../node-utils/index.js';
import type { ClaimProcessFacts } from './claim-process-observation.js';

type AtomicWriteResult = Awaited<ReturnType<FileSystem['writeAtomic']>>;
type PersistenceStage = 'claim_directory' | 'write_index' | 'write_record';

export type ClaimDecision =
  | { kind: 'reclaim'; reason: 'process_gone' | 'lease_elapsed' }
  | { kind: 'retain'; reason: 'unknown' | 'alive' | 'invalid_reference' | 'lease_active' }
  | { kind: 'skip'; reason: 'source_absent' | 'stat_failed' };

export type ClaimLease = {
  thresholdMs: number;
  observedAtMs: number;
  valueMs?: number;
  valueMsText?: string;
};

export type ClaimRecord = {
  version: 1;
  attemptId: string;
  sequence: number;
  atMs: number;
  sourceDir: string;
  rawName: string;
  originalName: string;
  event: 'process_observed' | 'decision';
  process?: ClaimProcessFacts;
  lease?: ClaimLease;
  decision?: ClaimDecision;
};

export class ClaimObservationPersistenceError extends Error {
  readonly code = 'CLAIM_OBSERVATION_PERSISTENCE_FAILED' as const;
  readonly rawName: string;

  constructor(
    public readonly entry: string,
    public readonly recordPath: string,
    public readonly pendingRecord: ClaimRecord,
    cause: unknown,
    public readonly writeResult?: AtomicWriteResult,
    public readonly originalStatError?: unknown,
    public readonly targetPath: string = recordPath,
    public readonly stage: PersistenceStage = 'write_record',
  ) {
    const location = targetPath === recordPath
      ? targetPath
      : `${targetPath} (pending record ${recordPath})`;
    const committed = writeResult !== undefined && writeResult.kind !== 'durable'
      ? ` (${writeResult.kind}; committed data must not be overwritten)`
      : '';
    super(`Claim observation persistence failed during ${stage} at ${location}${committed}`, { cause });
    this.name = 'ClaimObservationPersistenceError';
    this.rawName = pendingRecord.rawName;
  }
}

type ObservationInput = {
  rawName: string;
  originalName: string;
  process: ClaimProcessFacts;
};

type DecisionInput = {
  rawName: string;
  originalName: string;
  process?: ClaimProcessFacts;
  lease?: ClaimLease;
  decision: ClaimDecision;
};

type ClaimRecordInput = Omit<ClaimRecord,
  'version' | 'attemptId' | 'sequence' | 'atMs' | 'sourceDir'>;

type RecordOptions = {
  originalStatError?: unknown;
};

const MAX_DIRECTORY_CLAIMS = 3;

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/** Durable per-scan claim facts; no message state or recovery action is owned here. */
export class ClaimObservationStore {
  private currentAttemptId = newUuid();
  private directoryClaimed = false;
  private sequence = 0;
  private poisoned?: ClaimObservationPersistenceError;

  constructor(
    private readonly fs: FileSystem,
    private readonly sourceDir: string,
  ) {}

  private get observationDirName(): string {
    return `${this.sourceDir}-observations`;
  }

  private get attemptDirName(): string {
    return `${this.observationDirName}/${this.currentAttemptId}`;
  }

  private get recordPath(): string {
    return `${this.attemptDirName}/${String(this.sequence + 1).padStart(6, '0')}.json`;
  }

  private failure(
    stage: PersistenceStage,
    targetPath: string,
    record: ClaimRecord,
    recordPath: string,
    cause: unknown,
    options?: RecordOptions,
    writeResult?: AtomicWriteResult,
  ): ClaimObservationPersistenceError {
    const failure = new ClaimObservationPersistenceError(
      record.rawName,
      recordPath,
      record,
      cause,
      writeResult,
      options?.originalStatError,
      targetPath,
      stage,
    );
    this.poisoned = failure;
    return failure;
  }

  private async writeJson(
    stage: Exclude<PersistenceStage, 'claim_directory'>,
    targetPath: string,
    value: unknown,
    record: ClaimRecord,
    recordPath: string,
    options?: RecordOptions,
  ): Promise<void> {
    let content: string;
    try {
      const serialized = JSON.stringify(value) as string | undefined;
      if (serialized === undefined) throw new TypeError('Claim observation is not JSON serializable');
      content = serialized;
    } catch (error) {
      throw this.failure(stage, targetPath, record, recordPath, error, options);
    }

    let result: AtomicWriteResult;
    try {
      result = await this.fs.writeAtomic(targetPath, content);
    } catch (error) {
      throw this.failure(stage, targetPath, record, recordPath, error, options);
    }
    if (result.kind !== 'durable') {
      throw this.failure(stage, targetPath, record, recordPath, result.error, options, result);
    }
  }

  private makeRecord(input: ClaimRecordInput): ClaimRecord {
    return {
      version: 1,
      attemptId: this.currentAttemptId,
      sequence: this.sequence + 1,
      atMs: Date.now(),
      sourceDir: this.sourceDir,
      ...input,
    };
  }

  private async persist(input: ClaimRecordInput, options?: RecordOptions): Promise<void> {
    if (this.poisoned !== undefined) throw this.poisoned;

    let record = this.makeRecord(input);
    let recordPath = this.recordPath;

    if (!this.directoryClaimed) {
      let claimed = false;
      for (let claim = 0; claim < MAX_DIRECTORY_CLAIMS; claim += 1) {
        record = this.makeRecord(input);
        recordPath = this.recordPath;
        try {
          this.fs.mkdirExclusiveSync(this.attemptDirName);
          claimed = true;
          break;
        } catch (error) {
          if (!isEexist(error) || claim === MAX_DIRECTORY_CLAIMS - 1) {
            throw this.failure(
              'claim_directory', this.attemptDirName, record, recordPath, error, options,
            );
          }
          this.currentAttemptId = newUuid();
        }
      }
      if (!claimed) throw new Error('unreachable claim observation directory claim state');
      this.directoryClaimed = true;

      // The sibling index commits the attempt directory entry before its first record.
      const indexPath = `${this.observationDirName}/${this.currentAttemptId}.json`;
      await this.writeJson('write_index', indexPath, {
        version: 1,
        attemptId: this.currentAttemptId,
        sourceDir: this.sourceDir,
      }, record, recordPath, options);
    }

    await this.writeJson('write_record', recordPath, record, record, recordPath, options);
    this.sequence = record.sequence;
  }

  recordObservation(input: ObservationInput): Promise<void> {
    return this.persist({ ...input, event: 'process_observed' });
  }

  recordDecision(input: DecisionInput, options?: RecordOptions): Promise<void> {
    return this.persist({ ...input, event: 'decision' }, options);
  }
}
