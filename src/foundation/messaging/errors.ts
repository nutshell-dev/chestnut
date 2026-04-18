export class InboxListFailed extends Error {
  readonly code = 'INBOX_LIST_FAILED' as const;
  constructor(public readonly dir: string, public readonly cause: unknown) {
    super(`Failed to list inbox pending dir: ${dir}`);
    this.name = 'InboxListFailed';
  }
}
