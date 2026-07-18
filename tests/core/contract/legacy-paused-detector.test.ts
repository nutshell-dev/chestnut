/**
 * Phase 1123 Step D: legacy paused contract detector tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { listLegacyPausedContracts } from '../../../src/core/contract/lightweight-query.js';

describe('findLegacyPausedContracts', () => {
  let testDir: string;
  let clawDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = await createTempDir('legacy-paused-');
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await cleanupTempDir(testDir);
    vi.restoreAllMocks();
  });

  function makeManager() {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: { write: auditWrite, preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s } as any,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      notifyClaw: vi.fn(),
    });
  }

  async function seedLegacyPaused(contractId: string) {
    const dir = path.join(clawDir, 'contract', 'paused', contractId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'progress.json'),
      JSON.stringify({ schema_version: 1, subtasks: {} }),
    );
  }

  it('returns empty array when paused dir does not exist', async () => {
    const manager = makeManager();
    const result = await manager.findLegacyPausedContracts();
    expect(result).toEqual([]);
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('returns tagged legacy paused contracts and emits audit event', async () => {
    const manager = makeManager();
    await seedLegacyPaused('lp1');
    await seedLegacyPaused('lp2');

    const result = await manager.findLegacyPausedContracts();

    expect(result).toHaveLength(2);
    expect(result.map(r => r.contractId).sort()).toEqual(['lp1', 'lp2']);
    expect(result[0].sourcePath).toBe(path.join('contract', 'paused', result[0].contractId));

    const audits = auditWrite.mock.calls.filter(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_PAUSED_OBSERVED,
    );
    expect(audits).toHaveLength(2);
    expect(audits.some((c: any) => c.some((a: string) => a.includes('contractId=lp1')))).toBe(true);
    expect(audits.some((c: any) => c.some((a: string) => a.includes('contractId=lp2')))).toBe(true);
  });

  it('deduplicates audit events across repeated scans', async () => {
    const manager = makeManager();
    await seedLegacyPaused('lp1');

    await manager.findLegacyPausedContracts();
    await manager.findLegacyPausedContracts();

    const audits = auditWrite.mock.calls.filter(
      (c: any) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_LEGACY_PAUSED_OBSERVED,
    );
    expect(audits).toHaveLength(1);
  });

  it('lightweight helper returns the same refs without audit', async () => {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const dir = path.join(clawDir, 'contract', 'paused', 'lp3');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'progress.json'), JSON.stringify({ schema_version: 1, subtasks: {} }));

    const result = listLegacyPausedContracts(nodeFs, '.');

    expect(result).toEqual([
      { contractId: 'lp3', sourcePath: path.join('contract', 'paused', 'lp3'), state: 'legacy_paused' },
    ]);
  });
});
