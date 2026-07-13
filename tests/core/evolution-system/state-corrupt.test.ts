import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';

// ============================================================================
// Mock: SkillSystem
// ============================================================================
const { mockSkillRegistryLoadAll, mockSkillRegistryFormatForContext, mockSkillFactory } = vi.hoisted(() => {
  const loadAll = vi.fn().mockResolvedValue(undefined);
  const format = vi.fn().mockReturnValue('No skills loaded');
  return {
    mockSkillRegistryLoadAll: loadAll,
    mockSkillRegistryFormatForContext: format,
    mockSkillFactory: vi.fn(() => ({ loadAll, formatForContext: format })),
  };
});



// ============================================================================
// Mock: AsyncTaskSystem.schedule
// ============================================================================
const { mockSchedule } = vi.hoisted(() => ({
  mockSchedule: vi.fn().mockResolvedValue('mock-task-id'),
}));

// ============================================================================
// Helpers
// ============================================================================
async function setupEvolutionSystem(stateFileContent?: string) {
  // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
  const tmpBase = path.join(os.tmpdir(), `phase840-${randomUUID()}`);
  const motionDir = path.join(tmpBase, 'motion');
  await fs.mkdir(path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract'), { recursive: true });
  await fs.mkdir(path.join(motionDir, 'clawspace', 'dispatch-skills'), { recursive: true });

  if (stateFileContent !== undefined) {
    await fs.writeFile(path.join(motionDir, '.evolution-system-state.json'), stateFileContent);
  }

  const motionFs = new NodeFileSystem({ baseDir: motionDir });
  const mockAudit = { write: vi.fn() , preview: vi.fn((s: string) => s), message: vi.fn((s: string) => s), summary: vi.fn((s: string) => s)};
  const evolutionSystem = new EvolutionSystem({
    fs: motionFs,
    audit: mockAudit as any,
    taskSystem: { schedule: mockSchedule } as any,
    contractManager: {} as any,
    createSkillSystem: mockSkillFactory as any,
  });

  return { tmpBase, motionDir, evolutionSystem, mockAudit };
}

async function cleanup(tmpBase: string) {
  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
}

// ============================================================================
// Tests
// ============================================================================
describe('EvolutionSystem _loadState corrupt path', () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('corrupt JSON: audits STATE_LOAD_FAILED + resets state + backup file exists', async () => {
    const { tmpBase, motionDir, evolutionSystem, mockAudit } = await setupEvolutionSystem('not-valid-json{{{');
    auditSpy = vi.spyOn(mockAudit, 'write');

    // trigger _loadState via runRetroForContract (needs by-contract index to not ENOENT early)
    const contractId = 'c-' + randomUUID();
    const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
    await fs.writeFile(byContractPath, JSON.stringify({ targetClaw: 'claw-a', mode: 'shadow' }));

    await evolutionSystem.runRetroForContract(contractId, {
      motionFs: new NodeFileSystem({ baseDir: motionDir }),
      motionBaseDir: motionDir,
      motionAudit: { write: vi.fn() } as any,
      clawsBaseDir: path.join(motionDir, 'claws'),
      clawFsFactory: (clawDir) => new NodeFileSystem({ baseDir: clawDir }),
      clawContractManagerFactory: () => ({}) as any,
    });

    expect(auditSpy).toHaveBeenCalledWith(
      RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED,
      // phase 709: src 加 path col 第 1
      expect.stringContaining('path='),
      expect.stringContaining('backup='),
      expect.stringContaining('move_ok=true'),
      expect.stringContaining('reason='),
    );

    // backup file exists
    const files = await fs.readdir(motionDir);
    const backupFile = files.find(f => f.startsWith('.evolution-system-state.json.corrupt-'));
    expect(backupFile).toBeDefined();

    await cleanup(tmpBase);
  });

  it('legacy processedContractIds schema: migration + backup + audit emit', async () => {
    const { tmpBase, motionDir, evolutionSystem, mockAudit } = await setupEvolutionSystem(
      JSON.stringify({ version: 1, processedContractIds: [123, 'abc'], lastProcessedAt: new Date().toISOString() })
    );
    auditSpy = vi.spyOn(mockAudit, 'write');

    const contractId = 'c-' + randomUUID();
    const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
    await fs.writeFile(byContractPath, JSON.stringify({ targetClaw: 'claw-a', mode: 'shadow' }));

    await evolutionSystem.runRetroForContract(contractId, {
      motionFs: new NodeFileSystem({ baseDir: motionDir }),
      motionBaseDir: motionDir,
      motionAudit: { write: vi.fn() } as any,
      clawsBaseDir: path.join(motionDir, 'claws'),
      clawFsFactory: (clawDir) => new NodeFileSystem({ baseDir: clawDir }),
      clawContractManagerFactory: () => ({ getProgress: async () => ({ completed_at: new Date().toISOString() }) }) as any,
    });

    // phase 280: legacy schema 触发 migration audit（不再走 corrupt backup）
    const migrationCall = auditSpy.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_LEGACY_SCHEMA_MIGRATED_RESET,
    );
    expect(migrationCall).toBeDefined();
    expect(migrationCall!.some((arg: unknown) => typeof arg === 'string' && arg.includes('legacy_field=processedContractIds'))).toBe(true);

    await cleanup(tmpBase);
  });

  it('ENOENT remains silent (no audit)', async () => {
    const { tmpBase, motionDir, evolutionSystem, mockAudit } = await setupEvolutionSystem();
    auditSpy = vi.spyOn(mockAudit, 'write');

    const contractId = 'c-' + randomUUID();
    const byContractPath = path.join(motionDir, 'clawspace', 'pending-retrospective', 'by-contract', `${contractId}.json`);
    await fs.writeFile(byContractPath, JSON.stringify({ targetClaw: 'claw-a', mode: 'shadow' }));

    await evolutionSystem.runRetroForContract(contractId, {
      motionFs: new NodeFileSystem({ baseDir: motionDir }),
      motionBaseDir: motionDir,
      motionAudit: { write: vi.fn() } as any,
      clawsBaseDir: path.join(motionDir, 'claws'),
      clawFsFactory: (clawDir) => new NodeFileSystem({ baseDir: clawDir }),
      clawContractManagerFactory: () => ({}) as any,
    });

    // No STATE_LOAD_FAILED audit for ENOENT
    const loadFailedCalls = auditSpy.mock.calls.filter(c => c[0] === RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED);
    expect(loadFailedCalls).toHaveLength(0);

    await cleanup(tmpBase);
  });
});
