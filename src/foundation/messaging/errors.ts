export class InboxListFailed extends Error {
  readonly code = 'INBOX_LIST_FAILED' as const;
  constructor(public readonly dir: string, public readonly cause: unknown) {
    super(`Failed to list inbox pending dir: ${dir}`);
    this.name = 'InboxListFailed';
  }
}

export type InboxMoveOp = 'done' | 'failed' | 'ack_done' | 'nack_pending' | 'deliver_inflight' | 'reconcile_pending';

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

export type InboxMetaError =
  | { kind: 'not_found'; cause: unknown }
  | { kind: 'permission_denied'; cause: unknown }  // ← NEW phase 1013 E.5
  | { kind: 'io_failed'; cause: unknown }          // ← NEW phase 1013 E.5
  | { kind: 'read_failed'; cause: unknown }        // backward fallback for unclassified errors
  | { kind: 'parse_failed'; cause: unknown };
