/**
 * ExecContext fixture factory
 *
 * Provides `makeExecContext(overrides?)` for sound, type-safe test fixtures.
 * Centralizes default values so field additions only require one change.
 */

import { vi } from 'vitest';
import type { ExecContext } from '../../src/foundation/tool-protocol/index.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';

// frozen: shared mutable fixture immutability guard / 26 caller 共享、防 silent shared corrupt
const noopFs = Object.freeze({} as unknown as FileSystem);

export function makeExecContext(overrides: Partial<ExecContext> = {}): ExecContext {
  const defaults: ExecContext = {
    clawId: 'test-claw',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    clawDir: '/tmp/test-claw',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    workspaceDir: '/tmp/test-claw/clawspace',
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    syncDir: '/tmp/test-claw/.sync',
    callerType: 'claw',
    fs: noopFs,
    profile: 'full',
    getElapsedMs: () => 0,
    stopRequested: false,
    requestStop: vi.fn(),
    readFileState: new Map(),
  } as ExecContext;

  return { ...defaults, ...overrides } as ExecContext;
}
