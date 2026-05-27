/**
 * FileWatcher persistent option tests
 *
 * Module-level mock of chokidar to verify options passed through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWatcher } from '../../src/foundation/file-watcher/index.js';

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

import * as chokidar from 'chokidar';

describe('createWatcher persistent option', () => {
  beforeEach(() => {
    vi.mocked(chokidar.watch).mockClear();
  });

  it('defaults to persistent: true', () => {
    createWatcher('/tmp/x', () => {});
    expect(vi.mocked(chokidar.watch)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ persistent: true }),
    );
  });

  it('passes persistent: false through to chokidar', () => {
    createWatcher('/tmp/x', () => {}, { persistent: false });
    expect(vi.mocked(chokidar.watch)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ persistent: false }),
    );
  });
});
