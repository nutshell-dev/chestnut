/**
 * phase 1487 γ5: contract-events real composer unit test.
 */

import { describe, it, expect } from 'vitest';
import { composer } from '../../../src/assembly/guidance/composers/contract-events.js';
import { MOTION_CLAW_ID } from '../../../src/constants.js';

describe('phase 1487: contract-events composer', () => {
  it('motion own contract → null (session has context)', () => {
    expect(composer({ source_claw: MOTION_CLAW_ID, problem_pairs: '' })).toBeNull();
  });

  it('motion own contract even with problem_pairs → null (motion own dominates)', () => {
    // 边界：A3 path 不会真传 problem_pairs（thin body 无 subtask 信息）/ 但若误传 motion own 优先
    expect(composer({ source_claw: MOTION_CLAW_ID, problem_pairs: 'motion:abc' })).toBeNull();
  });

  it('worker clean (empty problem_pairs) → null', () => {
    expect(composer({ problem_pairs: '' })).toBeNull();
  });

  it('worker clean (problem_pairs undefined) → null', () => {
    expect(composer({})).toBeNull();
  });

  it('single problem (1 pair) → trace cmd with real ids + shadow recommendation', () => {
    const result = composer({ problem_pairs: 'worker-1:1780-abcd' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('clawforum claw worker-1 trace 1780-abcd');
    expect(result!.text).toContain('shadow 工具');
    expect(result!.text).toContain('子任务提交但有 last_failure');
  });

  it('multi problem (2 pairs) → enumerate trace cmds + plural intro', () => {
    const result = composer({ problem_pairs: 'worker-1:1780-abcd,worker-2:1780-cdef' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('clawforum claw worker-1 trace 1780-abcd');
    expect(result!.text).toContain('clawforum claw worker-2 trace 1780-cdef');
    expect(result!.text).toContain('2 个 contract');
    expect(result!.text).toContain('shadow 工具');
  });

  it('malformed pair (no colon) → skipped, others kept', () => {
    const result = composer({ problem_pairs: 'malformed,worker-1:1780-abcd' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('clawforum claw worker-1 trace 1780-abcd');
    expect(result!.text).not.toContain('malformed');
  });

  it('all malformed pairs → null', () => {
    expect(composer({ problem_pairs: 'malformed1,malformed2' })).toBeNull();
  });

  it('trims whitespace around pairs', () => {
    const result = composer({ problem_pairs: ' worker-1:abc , worker-2:def ' });
    expect(result).not.toBeNull();
    expect(result!.text).toContain('clawforum claw worker-1 trace abc');
    expect(result!.text).toContain('clawforum claw worker-2 trace def');
  });
});
