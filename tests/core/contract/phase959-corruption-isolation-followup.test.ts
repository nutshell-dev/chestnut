/**
 * Phase 959 — corruption isolation follow-up
 *
 * 1. isolation failure → markCrashed is NOT called
 * 2. YAML syntax error → enters isolation path
 * 3. existing backup path → retry with new UUID instead of overwrite
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { loadContractYaml } from '../../../src/core/contract/persistence.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { isolateCorruptedFile } from '../../../src/core/contract/_isolation-helper.js';
import * as nodeUtils from '../../../src/foundation/node-utils/index.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-phase959-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  vi.restoreAllMocks();
});

function makeManager(mockAudit: ReturnType<typeof makeMockAudit>) {
  return new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit: mockAudit as any,
    toolRegistry: createToolRegistry(),
    fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),
  });
}

describe('Phase 959 corruption isolation follow-up', () => {
  it('throws without calling markCrashed when isolation fails', async () => {
    const mockAudit = makeMockAudit();
    const manager = makeManager(mockAudit);
    const markCrashedSpy = vi.spyOn(manager as any, 'markCrashed');
    const moveSpy = vi.spyOn(nodeFs, 'move').mockRejectedValue(new Error('move denied'));

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const activeContractDir = path.join(clawDir, 'contract', 'active', contractId);
    const progressPath = path.join(activeContractDir, 'progress.json');
    await fs.writeFile(progressPath, '{not valid json', 'utf-8');

    await expect(manager.getProgress(contractId)).rejects.toThrow(
      /Cannot isolate corrupt progress\.json/,
    );

    expect(moveSpy).toHaveBeenCalled();
    expect(markCrashedSpy).not.toHaveBeenCalled();

    // Contract must remain in active (not archived) because markCrashed was skipped.
    await expect(fs.stat(activeContractDir)).resolves.toBeDefined();
    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.stat(archiveContractDir)).rejects.toThrow(/ENOENT/);

    // Isolation failure audit emitted with cannot-proceed context.
    expect(
      (mockAudit.write as any).mock.calls.some(
        (c: any[]) =>
          c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_FILE_ISOLATION_FAILED &&
          c.some((arg: any) => typeof arg === 'string' && arg.includes(`contractId=${contractId}`)) &&
          c.some((arg: any) => typeof arg === 'string' && arg.includes('context=isolation_failed_cannot_proceed')) &&
          c.some((arg: any) => typeof arg === 'string' && arg.includes('reason=isolation_move_failed')),
      ),
    ).toBe(true);
  });

  it('isolates contract.yaml with YAML syntax error', async () => {
    const contractId = 'yaml-broken';
    const activeContractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(activeContractDir, { recursive: true });
    await fs.writeFile(path.join(activeContractDir, 'contract.yaml'), '[not: valid yaml', 'utf-8');

    const mockAudit = makeMockAudit();
    const markCrashed = vi.fn(async (_contractId: string, _cause: string) => {});
    const result = await loadContractYaml({
      fs: nodeFs,
      audit: mockAudit as any,
      contractDir: async () => 'contract/active',
      getProgress: async () => ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
      markCrashed,
    }, contractId);

    expect(result).toBeNull();

    // yaml_parse_failed audit emitted.
    expect(
      (mockAudit.write as any).mock.calls.some(
        (c: any[]) =>
          c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID &&
          c.some((arg: any) => typeof arg === 'string' && arg.includes('reason=yaml_parse_failed')) &&
          c.some((arg: any) => typeof arg === 'string' && arg.startsWith('error=')),
      ),
    ).toBe(true);

    // File moved to corrupted/ subdir.
    const corruptedDir = path.join(activeContractDir, 'corrupted');
    const corruptedFiles = await fs.readdir(corruptedDir);
    expect(corruptedFiles.length).toBeGreaterThan(0);
    expect(corruptedFiles[0]).toMatch(/^\d+_[a-zA-Z0-9-]+_contract\.yaml$/);

    // markCrashed called with the YAML parse corruption cause.
    expect(markCrashed).toHaveBeenCalledWith(contractId, 'system: yaml_parse_corruption_contract_yaml');
  });

  it('retries with new UUID when backup path exists', async () => {
    const mockAudit = makeMockAudit();
    const contractId = 'uuid-retry';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(path.join(contractDir, 'progress.json'), '{broken', 'utf-8');

    const corruptedDir = path.join(contractDir, 'corrupted');
    await fs.mkdir(corruptedDir, { recursive: true });

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    // First UUID collides with a pre-existing backup file; second UUID is free.
    vi.spyOn(nodeUtils, 'newShortUuid')
      .mockReturnValueOnce('colliding-uuid')
      .mockReturnValueOnce('free-uuid');

    const existingBackupPath = path.join(corruptedDir, `${now}_colliding-uuid_progress.json`);
    await fs.writeFile(existingBackupPath, 'existing backup', 'utf-8');

    const result = await isolateCorruptedFile(nodeFs, mockAudit as any, {
      contractId,
      contractDir,
      filename: 'progress.json',
      reason: 'json_parse_error',
    });

    expect(result).not.toBeNull();
    expect(result!.backupPath).toContain('free-uuid');
    expect(result!.backupPath).not.toBe(existingBackupPath);

    // Original file moved to the new (non-colliding) backup path.
    await expect(fs.stat(result!.backupPath)).resolves.toBeDefined();
    // Pre-existing backup untouched.
    expect(await fs.readFile(existingBackupPath, 'utf-8')).toBe('existing backup');

    const corruptedFiles = await fs.readdir(corruptedDir);
    expect(corruptedFiles).toContain(path.basename(result!.backupPath));
    expect(corruptedFiles).toContain(path.basename(existingBackupPath));
  });
});
