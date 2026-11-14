export class InboxListFailed extends Error {
  readonly code = 'INBOX_LIST_FAILED' as const;
  constructor(public readonly dir: string, public readonly cause: unknown) {
    super(`Failed to list inbox pending dir: ${dir}`);
    this.name = 'InboxListFailed';
  }
}

type InboxMoveOp = 'done' | 'failed' | 'ack_done' | 'nack_pending' | 'deliver_inflight' | 'reconcile_pending' | 'misrouted' | 'defer_pending';

export class InboxMoveFailed extends Error {
  readonly code = 'INBOX_MOVE_FAILED' as const;
  constructor(
    public readonly filePath: string,
    public readonly op: InboxMoveOp,
    public readonly cause: unknown,
  ) {
    super(`Failed to move inbox file ${filePath} to ${op}/`);
    this.name = 'InboxMoveFailed';
  }
}

type OutboxMoveOp = 'done' | 'skipped' | 'failed';

/** Settlement move error with the original filesystem cause. */
export class OutboxMoveFailed extends Error {
  readonly code = 'OUTBOX_MOVE_FAILED' as const;
  constructor(
    public readonly filePath: string,
    public readonly op: OutboxMoveOp,
    public readonly cause: unknown,
  ) {
    super(`Failed to move outbox file ${filePath} to ${op === 'skipped' ? 'done' : op}/`);
    this.name = 'OutboxMoveFailed';
  }
}

/** A settlement handle was not minted by this reader or was already settled. */
export class OutboxClaimBindingError extends Error {
  readonly code = 'OUTBOX_CLAIM_BINDING_ERROR' as const;
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'OutboxClaimBindingError';
  }
}

/** Failed settlement is incomplete; both the consumption and settlement errors survive. */
export class OutboxSettlementRequired extends Error {
  readonly code = 'OUTBOX_SETTLEMENT_REQUIRED' as const;
  readonly status = 'settlement_required' as const;

  constructor(
    public readonly claimPath: string,
    public readonly filename: string,
    public readonly error: unknown,
    public readonly settlementError: unknown,
  ) {
    super(`Outbox failed settlement required for ${claimPath}`, { cause: settlementError });
    this.name = 'OutboxSettlementRequired';
  }
}

export class WireFieldError extends Error {
  readonly code = 'WIRE_FIELD_ERROR' as const;
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'WireFieldError';
  }
}

export class OutboxDecodeError extends Error {
  readonly code = 'OUTBOX_DECODE_ERROR' as const;
  constructor(public readonly reason: string) {
    super(`Failed to decode outbox message: ${reason}`);
    this.name = 'OutboxDecodeError';
  }
}

export class InboxDecodeError extends Error {
  readonly code = 'INBOX_DECODE_ERROR' as const;
  constructor(public readonly reason: string) {
    super(`Failed to decode inbox message: ${reason}`);
    this.name = 'InboxDecodeError';
  }
}

export type InboxMetaError =
  | { kind: 'not_found'; cause: unknown }
  | { kind: 'permission_denied'; cause: unknown }  // ← NEW phase 1013 E.5
  | { kind: 'io_failed'; cause: unknown }          // ← NEW phase 1013 E.5
  | { kind: 'read_failed'; cause: unknown }        // backward fallback for unclassified errors
  | { kind: 'parse_failed'; cause: unknown };
