import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { processCommandContainsToken } from '../../../src/foundation/process-exec/process-target.js';
import { observePidArgv } from '../../../src/foundation/process-exec/argv-verify.js';

vi.mock('child_process', () => ({ spawnSync: vi.fn() }));

const PID = 12345;

function rawResult(stdout: string): SpawnSyncReturns<string> {
  return {
    pid: 4321, status: 0, signal: null, stdout, stderr: '',
    output: [null, stdout, ''],
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('argv literal token boundaries', () => {
  it.each([
    { command: 'node daemon /work/a b', token: '/work/a b', matches: true },
    { command: 'node daemon\t/work/a b\n', token: '/work/a b', matches: true },
    { command: 'node daemon /work/a b-sibling', token: '/work/a b', matches: false },
    { command: 'node daemon prefix/work/a b', token: '/work/a b', matches: false },
    { command: 'node daemon /claws/a-sibling', token: '/claws/a', matches: false },
  ])('shares neutral matching between observation and cleanup: $command', ({ command, token, matches }) => {
    vi.mocked(spawnSync).mockReturnValue(rawResult(`${command}\n`) as unknown as ReturnType<typeof spawnSync>);

    expect(observePidArgv(PID, token).kind).toBe(matches ? 'match' : 'mismatch');
    expect(processCommandContainsToken(command, token)).toBe(matches);
  });
});
