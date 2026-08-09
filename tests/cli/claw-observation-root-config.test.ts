/** Phase 1328 Step B: trace/stream share the required ClawCommandDeps guard protocol. */
import { describe, it, expect } from 'vitest';
import { clawTraceCommand } from '../../src/cli/commands/claw-trace.js';
import { streamCommand } from '../../src/cli/commands/claw-stream.js';
import type { ClawCommandDeps } from '../../src/cli/commands/claw-command-deps.js';
import { makeContractId } from '../../src/core/contract/index.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';

type RunObservation = (deps: ClawCommandDeps) => Promise<void>;

const cases: ReadonlyArray<{ label: string; run: RunObservation }> = [
  { label: 'trace', run: (deps) => clawTraceCommand(deps, 'alice', makeContractId('C-1')) },
  { label: 'stream', run: (deps) => streamCommand(deps, 'alice') },
];

describe.each(cases)('claw $label RootConfig guard', ({ run }) => {
  it('valid config reaches the observation boundary after one ordered guard', async () => {
    const businessSentinel = new Error('observation boundary sentinel');
    const deps = makeClawCommandDeps(() => { throw businessSentinel; });
    await expect(run(deps)).rejects.toBe(businessSentinel);
    expect(deps.rootConfig.loadGlobal).toHaveBeenCalledTimes(1);
    expect(deps.rootConfig.loadClaw).toHaveBeenCalledTimes(1);
  });

  it('missing claw preserves the existing CliError before observation side effects', async () => {
    const deps = makeClawCommandDeps(
      () => { throw new Error('observation side effect must not run'); },
      { loadClaw: () => undefined },
    );
    await expect(run(deps)).rejects.toThrow('Claw "alice" does not exist');
  });

  it('global config failure propagates the same instance before loadClaw', async () => {
    const sentinel = new Error('global config sentinel');
    const deps = makeClawCommandDeps(
      () => { throw new Error('observation side effect must not run'); },
      { loadGlobal: () => { throw sentinel; } },
    );
    await expect(run(deps)).rejects.toBe(sentinel);
    expect(deps.rootConfig.loadClaw).not.toHaveBeenCalled();
  });

  it('claw config failure propagates the same instance', async () => {
    const sentinel = new Error('claw config sentinel');
    const deps = makeClawCommandDeps(
      () => { throw new Error('observation side effect must not run'); },
      { loadClaw: () => { throw sentinel; } },
    );
    await expect(run(deps)).rejects.toBe(sentinel);
  });
});
