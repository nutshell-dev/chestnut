/** Phase 1330 Step B: chat owns one required RootConfig read sequence. */
import { describe, it, expect } from 'vitest';
import { chatCommand } from '../../src/cli/commands/claw-chat.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';

describe('claw chat RootConfig boundary', () => {
  it('valid config reuses one global read before reaching viewport audit boundary', async () => {
    const businessSentinel = new Error('viewport audit boundary sentinel');
    const deps = makeClawCommandDeps(() => { throw businessSentinel; });
    await expect(chatCommand(deps, 'alice')).rejects.toBe(businessSentinel);
    expect(deps.rootConfig.loadGlobal).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.loadClaw).toHaveBeenCalledTimes(1);
  });

  it('missing claw preserves the guidance CliError before viewport side effects', async () => {
    const deps = makeClawCommandDeps(
      () => { throw new Error('viewport side effect must not run'); },
      { loadClaw: () => undefined },
    );
    await expect(chatCommand(deps, 'alice')).rejects.toThrow('Try `chestnut claw list`');
  });

  it('global config failure propagates the same instance before loadClaw', async () => {
    const sentinel = new Error('global config sentinel');
    const deps = makeClawCommandDeps(
      () => { throw new Error('viewport side effect must not run'); },
      { loadGlobal: () => { throw sentinel; } },
    );
    await expect(chatCommand(deps, 'alice')).rejects.toBe(sentinel);
    expect(deps.rootConfig.loadClaw).not.toHaveBeenCalled();
  });

  it('claw config failure propagates the same instance', async () => {
    const sentinel = new Error('claw config sentinel');
    const deps = makeClawCommandDeps(
      () => { throw new Error('viewport side effect must not run'); },
      { loadClaw: () => { throw sentinel; } },
    );
    await expect(chatCommand(deps, 'alice')).rejects.toBe(sentinel);
  });
});
