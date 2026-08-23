import { describe, expect, it } from 'vitest';
import { ProcessListUnavailable } from '../../../src/foundation/process-exec/index.js';
import * as processManagerSurface from '../../../src/foundation/process-manager/index.js';

describe('ProcessListUnavailable owner boundary', () => {
  it('is a ProcessExec typed failure with stable runtime identity', () => {
    const cause = new Error('pgrep unavailable');
    const error = new ProcessListUnavailable('daemon-pattern', cause);

    expect(error).toBeInstanceOf(ProcessListUnavailable);
    expect(error.name).toBe('ProcessListUnavailable');
    expect(error.cause).toBe(cause);
  });

  it('is not forwarded by the ProcessManager public surface', () => {
    expect('ProcessListUnavailable' in processManagerSurface).toBe(false);
  });
});
