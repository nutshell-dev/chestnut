import type { FileSystem } from '../fs/index.js';
import { newUuid } from '../node-utils/index.js';
import { captureCurrentProcessRef } from '../process-exec/index.js';
import {
  isValidClaimOriginalName,
  type ClaimChannel,
  type ClaimDescriptor,
  type ClaimRecordCapture,
} from './claim-record.js';

type AtomicWriteResult = Awaited<ReturnType<FileSystem['writeAtomic']>>;

export type ClaimPreparationStage =
  | 'capture'
  | 'claim_directory'
  | 'write_index'
  | 'write_record';

type ClaimPreparationErrorOptions = {
  targetPath: string;
  cause: unknown;
  capture?: ClaimRecordCapture;
  descriptor?: ClaimDescriptor;
  recordPath?: string;
  writeResult?: AtomicWriteResult;
};

export class ClaimPreparationError extends Error {
  readonly code = 'CLAIM_PREPARATION_FAILED' as const;
  readonly targetPath: string;
  readonly capture?: ClaimRecordCapture;
  readonly descriptor?: ClaimDescriptor;
  readonly recordPath?: string;
  readonly writeResult?: AtomicWriteResult;

  constructor(
    public readonly entry: string,
    public readonly stage: ClaimPreparationStage,
    options: ClaimPreparationErrorOptions,
  ) {
    const pendingRecord = options.recordPath !== undefined && options.recordPath !== options.targetPath
      ? ` (pending record ${options.recordPath})`
      : '';
    const committed = options.writeResult !== undefined && options.writeResult.kind !== 'durable'
      ? ` (${options.writeResult.kind}; committed data must not be overwritten)`
      : '';
    super(
      `Claim preparation failed for "${entry}" during ${stage} at ${options.targetPath}`
        + `${pendingRecord}${committed}`,
      { cause: options.cause },
    );
    this.name = 'ClaimPreparationError';
    this.targetPath = options.targetPath;
    this.capture = options.capture;
    this.descriptor = options.descriptor;
    this.recordPath = options.recordPath;
    this.writeResult = options.writeResult;
  }
}

const MAX_DIRECTORY_CLAIMS = 3;

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value) as string | undefined;
  if (serialized === undefined) throw new TypeError('Claim preparation value is not JSON serializable');
  return serialized;
}

export async function prepareClaimRecord(
  fs: FileSystem,
  sourceDir: string,
  channel: ClaimChannel,
  originalName: string,
): Promise<{ claimName: string; recordPath: string; descriptor: ClaimDescriptor }> {
  if (!isValidClaimOriginalName(originalName, channel)) {
    throw new TypeError(`Invalid claim originalName for ${channel}: ${JSON.stringify(originalName)}`);
  }

  const claimsDir = `${sourceDir}-claims`;
  let claimId = '';
  let claimName = '';
  let claimDirectory = '';
  let recordPath = '';

  for (let attempt = 0; attempt < MAX_DIRECTORY_CLAIMS; attempt += 1) {
    claimId = newUuid();
    claimName = `mclaim_1_${claimId}.md`;
    claimDirectory = `${claimsDir}/${claimId}`;
    recordPath = `${claimDirectory}/record.json`;
    try {
      fs.mkdirExclusiveSync(claimDirectory);
      break;
    } catch (cause) {
      if (!isEexist(cause) || attempt === MAX_DIRECTORY_CLAIMS - 1) {
        throw new ClaimPreparationError(originalName, 'claim_directory', {
          targetPath: claimDirectory,
          recordPath,
          cause,
        });
      }
    }
  }

  let capture: ClaimRecordCapture;
  try {
    capture = captureCurrentProcessRef();
  } catch (cause) {
    throw new ClaimPreparationError(originalName, 'capture', {
      targetPath: recordPath,
      recordPath,
      cause,
    });
  }

  const descriptor: ClaimDescriptor = {
    version: 1,
    claimId,
    channel,
    originalName,
    claimName,
    createdAtMs: Date.now(),
    capture,
  };
  const evidence = { capture, descriptor, recordPath };

  const indexPath = `${claimsDir}/${claimId}.json`;
  let indexContent: string;
  try {
    indexContent = serialize({ version: 1, claimId });
  } catch (cause) {
    throw new ClaimPreparationError(originalName, 'write_index', {
      targetPath: indexPath,
      ...evidence,
      cause,
    });
  }

  let indexResult: AtomicWriteResult;
  try {
    indexResult = await fs.writeAtomic(indexPath, indexContent);
  } catch (cause) {
    throw new ClaimPreparationError(originalName, 'write_index', {
      targetPath: indexPath,
      ...evidence,
      cause,
    });
  }
  if (indexResult.kind !== 'durable') {
    throw new ClaimPreparationError(originalName, 'write_index', {
      targetPath: indexPath,
      ...evidence,
      cause: indexResult.error,
      writeResult: indexResult,
    });
  }

  let recordContent: string;
  try {
    recordContent = serialize(descriptor);
  } catch (cause) {
    throw new ClaimPreparationError(originalName, 'write_record', {
      targetPath: recordPath,
      ...evidence,
      cause,
    });
  }

  let recordResult: AtomicWriteResult;
  try {
    recordResult = await fs.writeAtomic(recordPath, recordContent);
  } catch (cause) {
    throw new ClaimPreparationError(originalName, 'write_record', {
      targetPath: recordPath,
      ...evidence,
      cause,
    });
  }
  if (recordResult.kind !== 'durable') {
    throw new ClaimPreparationError(originalName, 'write_record', {
      targetPath: recordPath,
      ...evidence,
      cause: recordResult.error,
      writeResult: recordResult,
    });
  }

  return { claimName, recordPath, descriptor };
}
