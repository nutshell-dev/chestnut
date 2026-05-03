export class ProcessListUnavailable extends Error {
  readonly code = 'PROCESS_LIST_UNAVAILABLE' as const;
  constructor(public readonly pattern: string, public readonly cause: unknown) {
    super(`pgrep unavailable for pattern: ${pattern}`);
    this.name = 'ProcessListUnavailable';
  }
}
