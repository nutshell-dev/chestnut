/** Phase 1329 Step B: watch owns its required ClawCommandDeps guard. */
import { describe, it, expect } from 'vitest';
import { watchCommand } from '../../src/cli/commands/claw-watch.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';

describe('claw watch RootConfig guard', () => {
  it('valid config reaches the subscription boundary after one ordered guard', async () => {
    const businessSentinel = new Error('subscription boundary sentinel');
    const deps = makeClawCommandDeps(() => { throw businessSentinel; });
    await expect(watchCommand(deps, 'alice')).rejects.toBe(businessSentinel);
    expect(deps.rootConfig.loadGlobal).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.loadClaw).toHaveBeenCalledTimes(1);
  });

  it('missing claw preserves the existing CliError before subscription side effects', async () => {
    const deps = makeClawCommandDeps(
      () => { throw new Error('subscription side effect must not run'); },
      { loadClaw: () => undefined },
    );
    await expect(watchCommand(deps, 'alice')).rejects.toThrow('Claw "alice" does not exist');
  });

  it('global config failure propagates the same instance before loadClaw', async () => {
    const sentinel = new Error('global config sentinel');
    const deps = makeClawCommandDeps(
      () => { throw new Error('subscription side effect must not run'); },
      { loadGlobal: () => { throw sentinel; } },
    );
    await expect(watchCommand(deps, 'alice')).rejects.toBe(sentinel);
    expect(deps.rootConfig.loadClaw).not.toHaveBeenCalled();
  });

  it('claw config failure propagates the same instance', async () => {
    const sentinel = new Error('claw config sentinel');
    const deps = makeClawCommandDeps(
      () => { throw new Error('subscription side effect must not run'); },
      { loadClaw: () => { throw sentinel; } },
    );
    await expect(watchCommand(deps, 'alice')).rejects.toBe(sentinel);
  });
});
