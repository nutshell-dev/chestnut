/**
 * subagent-list command tests (phase 954 Step B)
 *
 * Coverage: --from / --to NaN guard reverse tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { subagentListCommand } from '../../../src/cli/commands/subagent-list.js';

vi.mock('fs');

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

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('--from garbage throws CliError (反向: NaN guard mirror --limit, phase 954)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentListCommand({ claw: 'test-claw', from: 'garbage' });

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('--from must be a valid date'));
  });

  it('--to garbage throws CliError (反向: NaN guard mirror --limit, phase 954)', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await subagentListCommand({ claw: 'test-claw', to: 'not-a-date' });

    expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining('--to must be a valid date'));
  });
});
