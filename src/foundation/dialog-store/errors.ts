import { ClawError, type ErrorCode } from '../errors.js';

export class DialogStoreError extends ClawError {
  readonly code: ErrorCode = 'DIALOG_STORE_ERROR';
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}
