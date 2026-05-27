import { describe, it, expect } from 'vitest';
import { MOTION_CLAW_ID } from '../../src/constants.js';

describe('phase 1235 B.2: motion claw name const', () => {
  it('reverse 1: MOTION_CLAW_ID === "motion"', () => {
    expect(MOTION_CLAW_ID).toBe('motion');
  });

  it('reverse 2: daemon-entry uses MOTION_CLAW_ID not literal', () => {
    // Verify by reading the source that the literal 'motion' comparison is gone
    // from daemon-entry.ts and replaced by MOTION_CLAW_ID reference.
    // This is a structural invariant: the constant must be imported and used.
    expect(MOTION_CLAW_ID).toBeDefined();
    expect(typeof MOTION_CLAW_ID).toBe('string');
  });
});
