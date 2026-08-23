import { describe, expect, it } from 'vitest';
import { DAEMON_SHUTDOWN_GRACE_MS as ownerValue } from '../../../src/foundation/process-manager/constants.js';
import { DAEMON_SHUTDOWN_GRACE_MS as publicValue } from '../../../src/foundation/process-manager/index.js';
import * as managerDeepSurface from '../../../src/foundation/process-manager/manager.js';

describe('ProcessManager shutdown grace owner boundary', () => {
  it('keeps the public constant bound to the constants owner', () => {
    expect(ownerValue).toBe(5000);
    expect(publicValue).toBe(ownerValue);
  });

  it('does not forward the constant from the ProcessManager class file', () => {
    expect('DAEMON_SHUTDOWN_GRACE_MS' in managerDeepSurface).toBe(false);
  });
});
