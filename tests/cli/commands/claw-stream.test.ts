/**
 * claw-stream command tests (phase 447 Step B).
 *
 * Coverage: parseStartMode (5 cases) + claw-not-exists error path.
 * Out of scope: long-running tail / signal handling / daemon liveness polling
 * (covered by e2e tests in future phase if needed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { streamCommand, parseStartMode } from '../../../src/cli/commands/claw-stream.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { getRelativeClawDir, getClawConfigPath } from '../../../src/core/claw-topology/index.js';
import { getGlobalConfigPath } from '../../../src/assembly/config/global-config-path.js';
import { CliError } from '../../../src/cli/errors.js';
import { makeClawCommandDeps, type FakeClawCommandDeps } from '../../helpers/claw-command-deps.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getRelativeClawDir: vi.fn(),
    getClawConfigPath: vi.fn(),
  };
});
vi.mock('../../../src/assembly/config/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/assembly/config/global-config-path.js')>();
  return {
    ...actual,
    getGlobalConfigPath: vi.fn(),
  };
});
describe('parseStartMode', () => {
  it('default (no args) → recent-turn', () => {
    expect(parseStartMode([])).toEqual({ kind: 'recent-turn' });
  });

  it('--from-now → now', () => {
    expect(parseStartMode(['--from-now'])).toEqual({ kind: 'now' });
  });

  it('--include-history → history', () => {
    expect(parseStartMode(['--include-history'])).toEqual({ kind: 'history' });
  });

  it('--from-recent-turn → recent-turn (explicit)', () => {
    expect(parseStartMode(['--from-recent-turn'])).toEqual({ kind: 'recent-turn' });
  });

  it('--from-offset 100 → offset 100', () => {
    expect(parseStartMode(['--from-offset', '100'])).toEqual({ kind: 'offset', value: 100 });
  });

  it('--from-offset 0 → offset 0 (boundary)', () => {
    expect(parseStartMode(['--from-offset', '0'])).toEqual({ kind: 'offset', value: 0 });
  });

  it('--from-offset non-integer → CliError', () => {
    expect(() => parseStartMode(['--from-offset', 'abc'])).toThrow(CliError);
    expect(() => parseStartMode(['--from-offset', 'abc'])).toThrow(/non-negative/);
  });

  it('--from-offset negative → CliError', () => {
    expect(() => parseStartMode(['--from-offset', '-5'])).toThrow(CliError);
  });

  it('--from-offset missing value → CliError', () => {
    expect(() => parseStartMode(['--from-offset'])).toThrow(CliError);
  });

  it('multiple flags: first matched wins', () => {
    expect(parseStartMode(['--from-now', '--include-history'])).toEqual({ kind: 'now' });
  });
});

describe('streamCommand', () => {
  let commandDeps: FakeClawCommandDeps;

  beforeEach(() => {
    commandDeps = makeClawCommandDeps(fsFactory);
    vi.mocked(getRelativeClawDir).mockImplementation((name: string) => path.join('claws', name));
    vi.mocked(getGlobalConfigPath).mockReturnValue('/tmp/chestnut/config.yaml');
    vi.mocked(getClawConfigPath).mockImplementation((name: string) => path.join('/tmp/chestnut/claws', name, 'config.yaml'));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws CliError when claw does not exist', async () => {
    commandDeps.rootConfig.loadClaw.mockReturnValue(undefined);
    await expect(streamCommand(commandDeps, 'nonexistent-claw'))
      .rejects.toBeInstanceOf(CliError);
    await expect(streamCommand(commandDeps, 'nonexistent-claw'))
      .rejects.toThrow(/does not exist/);
  });
});
