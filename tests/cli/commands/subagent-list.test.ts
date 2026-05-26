/**
 * subagent-list command tests (phase 954 Step B)
 *
 * Coverage: --from / --to NaN guard reverse tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { subagentListCommand } from '../../../src/cli/commands/subagent-list.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    statSync: vi.fn(() => ({ mtime: new Date(), size: 0 })),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('../../../src/cli/commands/subagent-helpers.js', () => ({
  resolveClawDir: vi.fn().mockReturnValue('/tmp/claws/test-claw'),
  scanSubagentResults: vi.fn().mockReturnValue([
    {
      id: 'task-1',
      kind: 'spawn',
      status: 'completed',
      startedAt: new Date('2026-05-15T10:00:00Z'),
      durationMs: 120_000,
    },
  ]),
  formatDate: vi.fn(() => '2026-05-15 10:00'),
  formatDuration: vi.fn(() => '2m'),
  truncateId: vi.fn((id: string) => id),
}));

describe('subagent-list', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { resolveClawDir } = await import('../../../src/cli/commands/subagent-helpers.js');
    vi.mocked(resolveClawDir).mockReturnValue('/tmp/claws/test-claw');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('--from garbage throws CliError (反向: NaN guard mirror --limit, phase 954)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentListCommand({ fsFactory }, { claw: 'test-claw', from: 'garbage' });

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('--from must be a valid date'));
  });

  it('--to garbage throws CliError (反向: NaN guard mirror --limit, phase 954)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentListCommand({ fsFactory }, { claw: 'test-claw', to: 'not-a-date' });

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('--to must be a valid date'));
  });
});
