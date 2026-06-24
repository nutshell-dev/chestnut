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
