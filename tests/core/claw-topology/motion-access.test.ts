import { describe, expect, it } from 'vitest';
import {
  createCapturedCliMotionAccess,
  createInternalSystemMotionAccess,
  createUserMotionAccess,
  MotionAccessDeniedError,
  requireMotionAccess,
  type MotionOperation,
} from '../../../src/core/claw-topology/motion-access.js';
import { MOTION_CLAW_ID } from '../../../src/core/claw-topology/motion-claw-id.js';
import { resolveClawLocation } from '../../../src/core/claw-topology/location.js';
import { resolveClawDaemonDir } from '../../../src/core/claw-topology/daemon-dir.js';
import { makeClawId } from '../../../src/foundation/claw-identity/index.js';

const OPERATIONS: readonly MotionOperation[] = [
  'read', 'configure', 'start', 'stop', 'dispatch', 'audit',
];

describe('Motion access capability', () => {
  it.each(OPERATIONS)('allows user, motion agent and internal system for %s', (operation) => {
    for (const capability of [
      createUserMotionAccess(operation),
      createCapturedCliMotionAccess(MOTION_CLAW_ID, operation),
      createInternalSystemMotionAccess(operation),
    ]) {
      expect(() => requireMotionAccess(capability, operation)).not.toThrow();
    }
  });

  it.each(OPERATIONS)('rejects other and forged system markers for %s', (operation) => {
    for (const marker of ['alice', 'task-123', '', 'system']) {
      const capability = createCapturedCliMotionAccess(marker, operation);
      expect(() => requireMotionAccess(capability, operation, 'test/command'))
        .toThrowError(expect.objectContaining({
          name: 'MotionAccessDeniedError',
          callerKind: 'agent',
          operation,
          commandName: 'test/command',
        }));
    }
  });

  it('rejects a forged structural system capability', () => {
    const forged = {
      caller: { kind: 'system', source: 'internal' },
      operation: 'read',
      evidence: 'internal-system',
    } as const;
    expect(() => requireMotionAccess(forged, 'read')).toThrowError(
      expect.objectContaining({ callerKind: 'system' }),
    );
  });

  it('rejects operation mismatch before allowing an otherwise privileged caller', () => {
    expect(() => requireMotionAccess(createInternalSystemMotionAccess('start'), 'stop', 'watchdog/stop'))
      .toThrowError(expect.objectContaining({
        callerKind: 'system',
        operation: 'stop',
        commandName: 'watchdog/stop',
      }));
  });

  it('does not expose agent marker contents in denial errors', () => {
    const capability = createCapturedCliMotionAccess('secret-token-value', 'read');
    let thrown: unknown;
    try {
      requireMotionAccess(capability, 'read');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MotionAccessDeniedError);
    expect((thrown as Error).message).not.toContain('secret-token-value');
  });

  it('direct Motion resolvers require capability', () => {
    expect(() => resolveClawLocation(MOTION_CLAW_ID)).toThrowError(MotionAccessDeniedError);
    expect(() => resolveClawDaemonDir(MOTION_CLAW_ID)).toThrowError(MotionAccessDeniedError);
    expect(resolveClawLocation(MOTION_CLAW_ID, createUserMotionAccess('read')).kind).toBe('motion');
    expect(resolveClawDaemonDir(MOTION_CLAW_ID, createUserMotionAccess('read')))
      .toContain(MOTION_CLAW_ID);
  });

  it('direct resolver validates the requested operation', () => {
    expect(() => resolveClawLocation(
      MOTION_CLAW_ID,
      createUserMotionAccess('read'),
      'configure',
    )).toThrowError(expect.objectContaining({ operation: 'configure' }));
  });

  it('ordinary claw topology remains capability-free', () => {
    expect(resolveClawLocation(makeClawId('ordinary')).kind).toBe('claw');
  });
});
