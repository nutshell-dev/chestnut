import { describe, expect, it } from 'vitest';
import {
  ProcessGenerationStateError,
  makeDaemonDir,
} from '../../../src/foundation/process-manager/index.js';
import * as managerDeepSurface from '../../../src/foundation/process-manager/manager.js';

describe('ProcessGenerationStateError deep surface', () => {
  it('keeps malformed generation facts on the types owner class', () => {
    const daemonDir = makeDaemonDir('/tmp/chestnut-daemon');
    const cause = new Error('invalid generation json');
    const error = new ProcessGenerationStateError(daemonDir, 'spawning', 'inspect', cause);

    expect(error).toBeInstanceOf(ProcessGenerationStateError);
    expect(error.daemonDir).toBe(daemonDir);
    expect(error.location).toBe('spawning');
    expect(error.operation).toBe('inspect');
    expect(error.cause).toBe(cause);
  });

  it('is not forwarded by the ProcessManager class file', () => {
    expect('ProcessGenerationStateError' in managerDeepSurface).toBe(false);
  });
});
