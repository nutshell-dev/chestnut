/**
 * AuditWriter rotateIfNeeded TOCTOU race-loser silent skip (phase 908 B3)
 *
 * Covers:
 * - raw ENOENT from moveSync → silent skip (race-loser benign)
 * - EACCES from moveSync → console.error still called
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuditWriter, _resetFallbackForTest } from '../../../src/foundation/audit/writer.js';

describe('AuditWriter rotateIfNeeded TOCTOU race-loser (B3)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    _resetFallbackForTest();
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('raw ENOENT from moveSync is silent (TOCTOU race-loser)', () => {
    const fs = {
      appendSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ size: 99999999 }),
      moveSync: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      syncSync: vi.fn(),
    };
    const writer = new AuditWriter(fs as any, 'audit.tsv', 1); // 1MB max → triggers rotate

    writer.write('EVENT', 'col1');

    expect(fs.statSync).toHaveBeenCalled();
    expect(fs.moveSync).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    // write should continue after silent rotate failure
    expect(fs.appendSync).toHaveBeenCalled();
  });

  it('EACCES from moveSync still logs console.error', () => {
    const fs = {
      appendSync: vi.fn(),
      statSync: vi.fn().mockReturnValue({ size: 99999999 }),
      moveSync: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }),
      syncSync: vi.fn(),
    };
    const writer = new AuditWriter(fs as any, 'audit.tsv', 1);

    writer.write('EVENT', 'col1');

    expect(fs.statSync).toHaveBeenCalled();
    expect(fs.moveSync).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[AUDIT CRITICAL] rotation check failed')
    );
    // write should continue after rotate failure
    expect(fs.appendSync).toHaveBeenCalled();
  });
});
