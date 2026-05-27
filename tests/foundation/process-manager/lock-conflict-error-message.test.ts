import { describe, it, expect } from 'vitest';
import { LockConflictError } from '../../../src/foundation/process-manager/types.js';

describe('LockConflictError default message', () => {
  it('does not contain "daemon" in the default message (ML#5 generic)', () => {
    const err = new LockConflictError('test-claw');
    expect(err.message).not.toContain('daemon');
  });

  it('contains generic "another process holds the lock" in the default message', () => {
    const err = new LockConflictError('test-claw');
    expect(err.message).toContain('another process holds the lock');
  });

  it('allows custom message override', () => {
    const custom = 'custom lock message';
    const err = new LockConflictError('test-claw', custom);
    expect(err.message).toBe(custom);
  });
});
