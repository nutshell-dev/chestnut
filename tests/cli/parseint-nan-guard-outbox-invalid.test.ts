import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { runCli, makeTempRoot } from './_parseint-helpers.js';

describe('CLI parseInt NaN guard - outbox invalid', () => {
  let root: string;
  let prevRoot: string | undefined;

  beforeEach(() => {
    root = makeTempRoot();
    prevRoot = process.env.CLAWFORUM_ROOT;
    process.env.CLAWFORUM_ROOT = root;
  });

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CLAWFORUM_ROOT;
    else process.env.CLAWFORUM_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('outbox --limit abc → CliError with clear message + exit code 1', async () => {
    const { stderr, exitCode } = await runCli(
      ['claw', 'outbox', 'test-claw', '--limit', 'abc'],
      { CLAWFORUM_ROOT: root }
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--limit must be a non-negative integer');
    expect(stderr).toContain('got: abc');
  }, 120000);
});
