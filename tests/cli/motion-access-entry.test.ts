import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommand } from '../../src/cli/commands/init.js';
import { startCommand as startWatchdog } from '../../src/cli/commands/watchdog-cli.js';
import { dispatchSkillListCommand } from '../../src/cli/commands/dispatch-skill-list.js';
import { notifyRunningDaemons } from '../../src/cli/commands/config.js';
import { captureCliCallerIdentity } from '../../src/cli/motion-cli-guard.js';
import { CALLER_AGENT_ID_ENV } from '../../src/foundation/command-tool/index.js';

describe('direct Motion command entry capability checks', () => {
  beforeEach(() => {
    vi.stubEnv(CALLER_AGENT_ID_ENV, 'alice');
    captureCliCallerIdentity();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    captureCliCallerIdentity();
    vi.restoreAllMocks();
  });

  it('init rejects another agent before reading initialization state', async () => {
    const getInitializationState = vi.fn();
    const deps = {
      fsFactory: vi.fn(),
      rootConfig: { getInitializationState },
    };
    await expect(initCommand(deps as never)).rejects.toMatchObject({
      callerKind: 'agent', operation: 'configure', commandName: 'init',
    });
    expect(getInitializationState).not.toHaveBeenCalled();
  });

  it('watchdog start rejects another agent before touching process state', async () => {
    const fsFactory = vi.fn();
    await expect(startWatchdog(fsFactory)).rejects.toMatchObject({
      callerKind: 'agent', operation: 'start', commandName: 'watchdog/start',
    });
    expect(fsFactory).not.toHaveBeenCalled();
  });

  it('dispatch list rejects another agent before constructing its store', async () => {
    const fsFactory = vi.fn();
    await expect(dispatchSkillListCommand({ fsFactory })).rejects.toMatchObject({
      callerKind: 'agent', operation: 'read', commandName: 'dispatch-skill/list',
    });
    expect(fsFactory).not.toHaveBeenCalled();
  });

  it('config reload notification rejects another agent before reading a revision', async () => {
    const readRevision = vi.fn();
    await expect(notifyRunningDaemons({
      fsFactory: vi.fn(),
      llmConfiguration: { readRevision },
    }, 'test')).rejects.toMatchObject({
      callerKind: 'agent', operation: 'configure', commandName: 'config/provider',
    });
    expect(readRevision).not.toHaveBeenCalled();
  });
});
