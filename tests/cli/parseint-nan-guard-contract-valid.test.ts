import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { runCli, makeTempRoot } from './_parseint-helpers.js';

describe('CLI parseInt NaN guard - contract valid', () => {
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

  it('contract events --since 1704067200000 → no NaN error, normal execution', async () => {
    const { stderr, exitCode } = await runCli(
      ['contract', 'events', 'test-claw', '--since', '1704067200000'],
      { CLAWFORUM_ROOT: root }
    );
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('--since must be a Unix timestamp in milliseconds');
  }, 120000);
});
