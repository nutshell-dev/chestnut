/** System idle timeout aborted the react loop. */
export class IdleTimeoutSignal {
  readonly name = 'IdleTimeoutSignal';
  constructor(public readonly timeoutMs: number) {}
}

/** Step loop yielded to process a high-priority inbox message. */
export class PriorityInboxInterrupt {
  readonly name = 'PriorityInboxInterrupt';
}

/** User explicitly interrupted the turn (e.g. Esc key). */
export class UserInterrupt {
  readonly name = 'UserInterrupt';
}
