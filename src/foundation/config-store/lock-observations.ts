import type { FileSystem } from '../fs/index.js';
import type {
  ProcessRefDecode,
  ProcessRefObservation,
} from '../process-exec/index.js';
import { newShortUuid } from '../node-utils/index.js';
import { ConfigStoreError } from './errors.js';

type AtomicWriteResult = ReturnType<FileSystem['writeAtomicSync']>;

type UnverifiableHolder = { kind: 'unverifiable'; reason: string };

export type HolderObservationInput = {
  lockRaw: string;
  decoded?: ProcessRefDecode;
  outcome: ProcessRefDecode | ProcessRefObservation | UnverifiableHolder;
  decision: 'consider_reclaim' | 'wait';
};

export type LockObservationRecord = HolderObservationInput & {
  version: 1;
  attemptId: string;
  sequence: number;
  atMs: number;
  event: 'holder_observation';
};

type ObservationFailureCause = {
  kind: 'lock_observation_persistence_failed';
  attemptId: string;
  attemptDir: string;
  record: LockObservationRecord;
  recordPath: string;
  targetPath: string;
  error: unknown;
  writeResult?: AtomicWriteResult;
};

const MAX_DIRECTORY_CLAIMS = 3;

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

/**
 * Per-acquisition durable process evidence. The directory is claimed only when
 * the first observation is ready; every record and the first index must commit
 * durably before the caller may act on that observation.
 */
export class LockObservationWriter {
  private currentAttemptId = newShortUuid();
  private directoryClaimed = false;
  private sequence = 0;

  constructor(
    private readonly fs: FileSystem,
    private readonly observationDirName: string,
  ) {}

  get attemptId(): string {
    return this.currentAttemptId;
  }

  get location(): string {
    return `${this.observationDirName}/${this.currentAttemptId}`;
  }

  private get attemptDirName(): string {
    return this.location;
  }

  private failure(
    record: LockObservationRecord,
    recordPath: string,
    targetPath: string,
    error: unknown,
    writeResult?: AtomicWriteResult,
  ): ConfigStoreError {
    const cause: ObservationFailureCause = {
      kind: 'lock_observation_persistence_failed',
      attemptId: this.currentAttemptId,
      attemptDir: this.location,
      record,
      recordPath,
      targetPath,
      error,
      ...(writeResult !== undefined && { writeResult }),
    };
    const committed = writeResult !== undefined && writeResult.kind !== 'durable'
      ? ` (${writeResult.kind}; committed data must not be overwritten)`
      : '';
    return new ConfigStoreError(
      'lock_indeterminate',
      `Config lock observation persistence failed at ${this.location}${committed}`,
      { cause },
    );
  }

  private writeJson(
    targetPath: string,
    value: unknown,
    record: LockObservationRecord,
    recordPath: string,
  ): void {
    let content: string;
    try {
      const serialized = JSON.stringify(value) as string | undefined;
      if (serialized === undefined) throw new TypeError('Lock observation is not JSON serializable');
      content = serialized;
    } catch (error) {
      throw this.failure(record, recordPath, targetPath, error);
    }

    let result: AtomicWriteResult;
    try {
      result = this.fs.writeAtomicSync(targetPath, content);
    } catch (error) {
      throw this.failure(record, recordPath, targetPath, error);
    }
    if (result.kind !== 'durable') {
      throw this.failure(record, recordPath, targetPath, result.error, result);
    }
  }

  private makeRecord(input: HolderObservationInput): LockObservationRecord {
    return {
      version: 1,
      attemptId: this.currentAttemptId,
      sequence: this.sequence + 1,
      atMs: Date.now(),
      event: 'holder_observation',
      ...input,
    };
  }

  record(input: HolderObservationInput): void {
    let record = this.makeRecord(input);
    let recordPath = `${this.attemptDirName}/${String(record.sequence).padStart(6, '0')}.json`;

    if (!this.directoryClaimed) {
      let claimed = false;
      for (let claim = 0; claim < MAX_DIRECTORY_CLAIMS; claim += 1) {
        record = this.makeRecord(input);
        recordPath = `${this.attemptDirName}/${String(record.sequence).padStart(6, '0')}.json`;
        try {
          this.fs.mkdirExclusiveSync(this.attemptDirName);
          claimed = true;
          break;
        } catch (error) {
          if (!isEexist(error) || claim === MAX_DIRECTORY_CLAIMS - 1) {
            throw this.failure(record, recordPath, this.attemptDirName, error);
          }
          this.currentAttemptId = newShortUuid();
        }
      }
      if (!claimed) {
        throw new Error('unreachable lock observation directory claim state');
      }
      this.directoryClaimed = true;

      // This sibling index fsyncs the observation directory itself, committing
      // the attempt directory entry before the first observation is considered.
      const indexPath = `${this.observationDirName}/${this.currentAttemptId}.json`;
      this.writeJson(indexPath, {
        version: 1,
        attemptId: this.currentAttemptId,
        configFileName: this.observationDirName.slice(0, -'.lock-observations'.length),
      }, record, recordPath);
    }

    this.writeJson(recordPath, record, record, recordPath);
    this.sequence = record.sequence;
  }
}
