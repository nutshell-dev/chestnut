import { describe, expect, it } from 'vitest';
import {
  ProcessWinnerConvergenceError,
  makeDaemonDir,
} from '../../../src/foundation/process-manager/index.js';
import * as managerDeepSurface from '../../../src/foundation/process-manager/manager.js';

describe('ProcessWinnerConvergenceError deep surface', () => {
  it('keeps winner convergence facts on the types owner class', () => {
    const daemonDir = makeDaemonDir('/tmp/chestnut-daemon');
    const error = new ProcessWinnerConvergenceError(
      daemonDir,
      'winner_failed',
      'generation-1',
      'winner failed before ready',
    );

    expect(error).toBeInstanceOf(ProcessWinnerConvergenceError);
    expect(error.daemonDir).toBe(daemonDir);
    expect(error.reason).toBe('winner_failed');
    expect(error.generationId).toBe('generation-1');
    expect(error.message).toBe('winner failed before ready');
  });

  it('is not forwarded by the ProcessManager class file', () => {
    expect('ProcessWinnerConvergenceError' in managerDeepSurface).toBe(false);
  });
});
