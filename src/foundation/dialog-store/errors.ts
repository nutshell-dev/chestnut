import { formatErr } from '../node-utils/index.js';

export type DialogStoreErrorCode = 'DIALOG_STORE_ERROR';

export class DialogStoreError extends Error {
  readonly code: DialogStoreErrorCode = 'DIALOG_STORE_ERROR';
  readonly context?: Record<string, unknown>;
  readonly timestamp: string = new Date().toISOString();

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.context = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      ...(this.cause !== undefined && { cause: formatErr(this.cause) }),
    };
  }
}

/** Phase 990: transient read/write fault from the underlying FileSystem. */
export class DialogIOError extends Error {
  constructor(message: string, readonly causeErr: unknown) {
    super(message);
    this.name = 'DialogIOError';
  }
}

/** Phase 990: data corruption (JSON/schema/version invalid) in a dialog file. */
export class CorruptionError extends DialogStoreError {
  constructor(message: string, readonly causeErr: unknown) {
    super(message);
    this.name = 'CorruptionError';
  }
}
