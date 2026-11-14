import type { ProcessEvidence } from '../process-exec/index.js';
import { encodeProcessEvidence } from '../process-exec/index.js';
import { MESSAGING_AUDIT_EVENTS } from './audit-events.js';
import type { MessagingAuditSink } from './audit-sink.js';

export type RecoveryIoOperation = 'restore' | 'list' | 'stat' | 'read' | 'move' | 'delete';

/** Durable recovery facts; `error` is the lossless ProcessEvidence envelope. */
export type RecoveryIoEvidence = {
  operation: RecoveryIoOperation;
  stage: string;
  path: string;
  sourcePath?: string;
  targetPath?: string;
  completedActions?: readonly string[];
  code?: string;
  error: ProcessEvidence;
};

export type RecoveryIoInput = Omit<RecoveryIoEvidence, 'code' | 'error'> & {
  error: unknown;
  rawName?: string;
  originalName?: string;
};

function errorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    // Evidence encoding must not execute a hostile accessor a second time.
    return undefined;
  }
}

export function encodeRecoveryIoEvidence(input: RecoveryIoInput): RecoveryIoEvidence {
  const code = errorCode(input.error);
  return {
    operation: input.operation,
    stage: input.stage,
    path: input.path,
    ...(input.sourcePath !== undefined && { sourcePath: input.sourcePath }),
    ...(input.targetPath !== undefined && { targetPath: input.targetPath }),
    ...(input.completedActions !== undefined && { completedActions: [...input.completedActions] }),
    ...(code !== undefined && { code }),
    error: encodeProcessEvidence(Date.now(), [input.error]),
  };
}

/** Audit first, then require a durable recovery_io record before recovery continues. */
interface RecoveryObservationWriter {
  recordRecoveryIo(
    input: { rawName?: string; originalName?: string; recovery: RecoveryIoEvidence },
    options: { originalRecoveryError: unknown },
  ): Promise<void>;
}

export async function recordRecoveryIo(
  store: RecoveryObservationWriter,
  audit: MessagingAuditSink,
  input: RecoveryIoInput,
): Promise<void> {
  const evidence = encodeRecoveryIoEvidence(input);
  audit.write(
    MESSAGING_AUDIT_EVENTS.MESSAGING_RECOVERY_IO_FAILED,
    `evidence=${JSON.stringify(evidence)}`,
  );
  await store.recordRecoveryIo({
    ...(input.rawName !== undefined && { rawName: input.rawName }),
    ...(input.originalName !== undefined && { originalName: input.originalName }),
    recovery: evidence,
  }, { originalRecoveryError: input.error });
}
