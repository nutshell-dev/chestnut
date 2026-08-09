/** Phase 1327 Step B: send/import share the required ClawCommandDeps guard protocol. */
import { describe, it, expect } from 'vitest';
import { sendCommand } from '../../src/cli/commands/claw-send.js';
import { importCommand } from '../../src/cli/commands/claw-import.js';
import type { ClawCommandDeps } from '../../src/cli/commands/claw-command-deps.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';

type RunInputCommand = (deps: ClawCommandDeps) => Promise<void>;

const cases: ReadonlyArray<{ label: string; run: RunInputCommand }> = [
  { label: 'send', run: (deps) => sendCommand(deps, 'alice', 'hello') },
  { label: 'import', run: (deps) => importCommand(deps, 'note.md', 'alice') },
];

describe.each(cases)('claw $label RootConfig guard', ({ run }) => {
  it('valid config reaches the business boundary after one ordered guard', async () => {
    const businessSentinel = new Error('business boundary sentinel');
    const deps = makeClawCommandDeps(() => { throw businessSentinel; });
    await expect(run(deps)).rejects.toBe(businessSentinel);
    expect(deps.rootConfig.loadGlobal).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.loadClaw).toHaveBeenCalledTimes(1);
  });

  it('missing claw preserves the existing CliError before business side effects', async () => {
    const deps = makeClawCommandDeps(
      () => { throw new Error('business side effect must not run'); },
      { loadClaw: () => undefined },
    );
    await expect(run(deps)).rejects.toThrow('Claw "alice" does not exist');
  });

  it('global config failure propagates the same instance before loadClaw', async () => {
    const sentinel = new Error('global config sentinel');
    const deps = makeClawCommandDeps(
      () => { throw new Error('business side effect must not run'); },
      { loadGlobal: () => { throw sentinel; } },
    );
    await expect(run(deps)).rejects.toBe(sentinel);
    expect(deps.rootConfig.loadClaw).not.toHaveBeenCalled();
  });

  it('claw config failure propagates the same instance', async () => {
    const sentinel = new Error('claw config sentinel');
    const deps = makeClawCommandDeps(
      () => { throw new Error('business side effect must not run'); },
      { loadClaw: () => { throw sentinel; } },
    );
    await expect(run(deps)).rejects.toBe(sentinel);
  });
});
