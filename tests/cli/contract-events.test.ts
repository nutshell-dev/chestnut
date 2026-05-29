/**
 * contractEventsCommand tests
 *
 * Verifies contract event detection:
 * - completed contracts in archive (since timestamp)
 * - no output when no events
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsAsync from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mockAuditWrite = vi.hoisted(() => vi.fn());

vi.mock('../../src/foundation/config/index.js', () => ({
  getClawDir: (name: string) => (globalThis as any).__TEST_CLAW_DIR__,
}));

vi.mock('../../src/foundation/audit/index.js', () => ({
  createSystemAudit: vi.fn(() => ({
    write: mockAuditWrite,
  })),
}));

import { contractEventsCommand } from '../../src/cli/commands/contract.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('contractEventsCommand', () => {
  let clawDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    clawDir = await fsAsync.mkdtemp(path.join(os.tmpdir(), 'contract-events-test-'));
    (globalThis as any).__TEST_CLAW_DIR__ = clawDir;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockAuditWrite.mockClear();
  });

  afterEach(async () => {
    logSpy.mockRestore();
    delete (globalThis as any).__TEST_CLAW_DIR__;
    await fsAsync.rm(clawDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should output nothing when no archive or active directories exist', async () => {
    await contractEventsCommand({ fsFactory }, 'test-claw', 0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('should detect completed contract in archive since timestamp', async () => {
    const contractId = 'contract-001';
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    fs.mkdirSync(archiveDir, { recursive: true });

    const completedAt = new Date('2026-04-17T10:00:00Z');
    fs.writeFileSync(path.join(archiveDir, 'progress.json'), JSON.stringify({
      contract_id: contractId,
      status: 'completed',
      subtasks: {
        't1': { status: 'done', completed_at: completedAt.toISOString() },
      },
    }));

    // sinceTs before completion → should detect
    await contractEventsCommand({ fsFactory }, 'test-claw', completedAt.getTime() - 1000);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[contract_completed]'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(contractId),
    );
  });

  it('should not detect completed contract when completed before sinceTs', async () => {
    const contractId = 'contract-002';
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    fs.mkdirSync(archiveDir, { recursive: true });

    const completedAt = new Date('2026-04-17T10:00:00Z');
    fs.writeFileSync(path.join(archiveDir, 'progress.json'), JSON.stringify({
      contract_id: contractId,
      status: 'completed',
      subtasks: {
        't1': { status: 'done', completed_at: completedAt.toISOString() },
      },
    }));

    // sinceTs after completion → should not detect
    await contractEventsCommand({ fsFactory }, 'test-claw', completedAt.getTime() + 1000);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('handles corrupted progress.json gracefully in archive', async () => {
    const contractId = 'contract-corrupt';
    const archiveDir = path.join(clawDir, 'contract', 'archive', contractId);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'progress.json'), '{invalid json');

    await expect(contractEventsCommand({ fsFactory }, 'test-claw', 0)).resolves.not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
    expect(mockAuditWrite).toHaveBeenCalledWith(
      'contract_progress_corrupted',
      expect.stringContaining('clawId=test-claw'),
      expect.stringContaining('contract=contract-corrupt'),
      expect.anything(),
      expect.anything(),
    );
  });
});
