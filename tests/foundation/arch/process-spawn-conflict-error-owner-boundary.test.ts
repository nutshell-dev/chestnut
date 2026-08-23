import { describe, expect, it } from 'vitest';
import {
  ProcessSpawnConflictError as OwnerProcessSpawnConflictError,
  makeDaemonDir,
} from '../../../src/foundation/process-manager/types.js';
import { ProcessSpawnConflictError as PublicProcessSpawnConflictError } from '../../../src/foundation/process-manager/index.js';
import * as managerDeepSurface from '../../../src/foundation/process-manager/manager.js';

describe('ProcessSpawnConflictError owner boundary', () => {
  it('keeps the public error bound to the types owner with its conflict facts', () => {
    const daemonDir = makeDaemonDir('/tmp/chestnut-daemon');
    const error = new PublicProcessSpawnConflictError(daemonDir, 'commit_lost', 'generation-2');

    expect(PublicProcessSpawnConflictError).toBe(OwnerProcessSpawnConflictError);
    expect(error).toBeInstanceOf(OwnerProcessSpawnConflictError);
    expect(error.reason).toBe('commit_lost');
    expect(error.generationId).toBe('generation-2');
    expect(error.daemonDir).toBe(daemonDir);
  });

  it('does not forward the error from the ProcessManager class file', () => {
    expect('ProcessSpawnConflictError' in managerDeepSurface).toBe(false);
  });
});
