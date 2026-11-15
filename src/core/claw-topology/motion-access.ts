/**
 * @module L4.ClawTopology.MotionAccess
 *
 * Caller-scoped access to Motion topology. The CLI owns marker capture; this
 * module owns the typed capability and its authorization invariant. Neither
 * resolver nor capability construction reads process.env.
 */

import { MOTION_CLAW_ID } from './motion-claw-id.js';

export type MotionCaller =
  | { readonly kind: 'system'; readonly source: 'internal' }
  | { readonly kind: 'user'; readonly source: 'terminal' }
  | { readonly kind: 'motion-agent'; readonly agentId: typeof MOTION_CLAW_ID }
  | { readonly kind: 'agent'; readonly agentId: string };

export type MotionOperation = 'read' | 'configure' | 'start' | 'stop' | 'dispatch' | 'audit';

export type MotionAccessCapability = Readonly<{
  caller: MotionCaller;
  operation: MotionOperation;
  evidence: 'captured-cli-marker' | 'internal-system' | 'user-terminal';
}>;

const ISSUED_CAPABILITIES = new WeakSet<MotionAccessCapability>();

function issueMotionAccess(capability: MotionAccessCapability): MotionAccessCapability {
  Object.freeze(capability.caller);
  const issued = Object.freeze(capability);
  ISSUED_CAPABILITIES.add(issued);
  return issued;
}

export class MotionAccessDeniedError extends Error {
  constructor(
    public readonly callerKind: MotionCaller['kind'] | 'missing',
    public readonly operation: MotionOperation,
    public readonly commandName: string,
    reason: 'missing-capability' | 'untrusted-capability' | 'operation-mismatch' | 'caller-not-allowed',
  ) {
    super(
      `motion access denied: caller=${callerKind} operation=${operation} ` +
      `command=${commandName} reason=${reason}`,
    );
    this.name = 'MotionAccessDeniedError';
  }
}

/** Convert the one-time CLI capture into a capability; never re-read the marker. */
export function createCapturedCliMotionAccess(
  capturedCallerAgentId: string | undefined,
  operation: MotionOperation,
): MotionAccessCapability {
  if (capturedCallerAgentId === undefined) return createUserMotionAccess(operation);
  const caller: MotionCaller = capturedCallerAgentId === MOTION_CLAW_ID
    ? { kind: 'motion-agent', agentId: MOTION_CLAW_ID }
    : { kind: 'agent', agentId: capturedCallerAgentId };
  return issueMotionAccess({ caller, operation, evidence: 'captured-cli-marker' });
}

export function createUserMotionAccess(operation: MotionOperation): MotionAccessCapability {
  return issueMotionAccess({
    caller: { kind: 'user', source: 'terminal' },
    operation,
    evidence: 'user-terminal',
  });
}

/**
 * The only system-caller constructor. Callers are restricted by the source
 * architecture guard; argv/env capture can never produce this capability.
 */
export function createInternalSystemMotionAccess(operation: MotionOperation): MotionAccessCapability {
  return issueMotionAccess({
    caller: { kind: 'system', source: 'internal' },
    operation,
    evidence: 'internal-system',
  });
}

export function requireMotionAccess(
  capability: MotionAccessCapability | undefined,
  operation: MotionOperation,
  commandName = 'motion-resolver',
): void {
  if (!capability) {
    throw new MotionAccessDeniedError('missing', operation, commandName, 'missing-capability');
  }
  if (!ISSUED_CAPABILITIES.has(capability)) {
    throw new MotionAccessDeniedError(
      capability.caller.kind,
      operation,
      commandName,
      'untrusted-capability',
    );
  }
  if (capability.operation !== operation) {
    throw new MotionAccessDeniedError(
      capability.caller.kind,
      operation,
      commandName,
      'operation-mismatch',
    );
  }
  if (capability.caller.kind === 'agent') {
    throw new MotionAccessDeniedError(
      capability.caller.kind,
      operation,
      commandName,
      'caller-not-allowed',
    );
  }
}
