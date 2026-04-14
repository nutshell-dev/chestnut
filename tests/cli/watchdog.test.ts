/**
 * watchdog tests — fix 4: per-claw try-catch in maybeCronClawInactivity
 *
 * When one claw's check throws, the loop should continue and check remaining claws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { ProcessManager } from '../../src/foundation/process-manager/index.js';

// Mock config so getClawforumDir() and getGlobalConfig() return controllable values
vi.mock('../../src/cli/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/config.js')>();
  return {
    ...actual,
    getMotionDir: vi.fn(),
    loadGlobalConfig: vi.fn(),
  };
});

// Mock watchdog-utils so we can control clawHasContract
vi.mock('../../src/cli/commands/watchdog-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/commands/watchdog-utils.js')>();
  return {
    ...actual,
    clawHasContract: vi.fn(),
    getClawActivityInfo: vi.fn(),
    gatherClawSnapshot: vi.fn(),
    shouldResetNotifyCount: vi.fn().mockReturnValue(false),
    getEffectiveInterval: vi.fn().mockReturnValue(999_999_999),
  };
});

import { maybeCronClawInactivity } from '../../src/cli/commands/watchdog.js';
import { getMotionDir, loadGlobalConfig } from '../../src/cli/config.js';
import { clawHasContract } from '../../src/cli/commands/watchdog-utils.js';

describe('maybeCronClawInactivity — fix 4: per-claw error isolation', () => {
  let tmpDir: string;
  let clawsDir: string;
  let mockPm: ProcessManager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `wdfix4-${randomUUID()}`);
    // .clawforum layout: getMotionDir() returns .clawforum/motion, parent is .clawforum
    const clawforumDir = path.join(tmpDir, '.clawforum');
    clawsDir = path.join(clawforumDir, 'claws');
    fs.mkdirSync(clawsDir, { recursive: true });

    // Create two claw directories
    fs.mkdirSync(path.join(clawsDir, 'claw-a'), { recursive: true });
    fs.mkdirSync(path.join(clawsDir, 'claw-b'), { recursive: true });

    // Wire up mocks
    vi.mocked(getMotionDir).mockReturnValue(path.join(clawforumDir, 'motion'));
    vi.mocked(loadGlobalConfig).mockReturnValue({ watchdog: { claw_inactivity_timeout_ms: 300_000 } } as any);

    mockPm = { isAlive: vi.fn().mockReturnValue(false) } as unknown as ProcessManager;
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('continues checking claw-b even when claw-a check throws', () => {
    // claw-a throws; claw-b returns false (no contract → skip)
    vi.mocked(clawHasContract)
      .mockImplementationOnce(() => { throw new Error('stat error'); })
      .mockReturnValueOnce(false);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => maybeCronClawInactivity(mockPm)).not.toThrow();

    // clawHasContract should be called for both claws
    expect(clawHasContract).toHaveBeenCalledTimes(2);

    // Error for claw-a should have been logged
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error checking claw'),
    );

    logSpy.mockRestore();
  });

  it('does not throw even if all claws error', () => {
    vi.mocked(clawHasContract).mockImplementation(() => {
      throw new Error('all fail');
    });

    expect(() => maybeCronClawInactivity(mockPm)).not.toThrow();
    expect(clawHasContract).toHaveBeenCalledTimes(2);
  });
});
