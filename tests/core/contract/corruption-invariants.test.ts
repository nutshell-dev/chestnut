/**
 * Merged corruption-invariants test file (mechanical merge; assertion logic unchanged).
 *
 * Sources:
 * - phase958-corruption-isolation.test.ts
 * - phase959-corruption-isolation-followup.test.ts
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

/**
 * Phase 958 — corruption isolation invariants
 *
 * 1. corrupt progress.json → markCrashed succeeds + file isolated
 * 2. JSON.parse SyntaxError → enters isolation path
 * 3. same-millisecond isolation → unique backup filenames
 */
describe('Phase 958 corruption isolation', () => {
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-phase958-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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

  it('succeeds both markCrashed and isolation for corrupt progress.json', async () => {
    const mockAudit = makeMockAudit();
    const manager = makeManager(mockAudit);

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const activeContractDir = path.join(clawDir, 'contract', 'active', contractId);
    const progressPath = path.join(activeContractDir, 'progress.json');
    await fs.writeFile(progressPath, JSON.stringify({ schema_version: 1, foo: 'bar' }), 'utf-8');

    const result = await manager.getProgress(contractId);
    expect(result).toBeNull();

    // Contract moved to archive = markCrashed succeeded
    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    await expect(fs.stat(archiveContractDir)).resolves.toBeDefined();

    // Corrupt progress.json isolated under archive/corrupted/
    const corruptedDir = path.join(archiveContractDir, 'corrupted');
    const corruptedFiles = await fs.readdir(corruptedDir);
    expect(corruptedFiles.length).toBeGreaterThan(0);
    expect(corruptedFiles[0]).toMatch(/^\d+_[a-zA-Z0-9-]+_progress\.json$/);

    // No post-isolation markCrashed failure audit
    const isolationFailedCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_FILE_ISOLATION_FAILED,
    );
    expect(isolationFailedCalls).toHaveLength(0);
  });

  it('isolates progress.json with JSON syntax error', async () => {
    const mockAudit = makeMockAudit();
    const manager = makeManager(mockAudit);

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const activeContractDir = path.join(clawDir, 'contract', 'active', contractId);
    const progressPath = path.join(activeContractDir, 'progress.json');
    await fs.writeFile(progressPath, '{not valid json', 'utf-8');

    const result = await manager.getProgress(contractId);
    expect(result).toBeNull();

    // json_parse_failed audit emitted
    expect(mockAudit.write).toHaveBeenCalledWith(
      CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
      expect.stringContaining(`contractId=${contractId}`),
      expect.stringContaining('reason=json_parse_failed'),
      expect.stringContaining('error='),
    );

    // File moved to corrupted/ subdir
    const archiveContractDir = path.join(clawDir, 'contract', 'archive', contractId);
    const corruptedDir = path.join(archiveContractDir, 'corrupted');
    const corruptedFiles = await fs.readdir(corruptedDir);
    expect(corruptedFiles.length).toBeGreaterThan(0);
    expect(corruptedFiles[0]).toMatch(/^\d+_[a-zA-Z0-9-]+_progress\.json$/);
  });

  it('creates unique backup paths for same-millisecond isolation', async () => {
    const mockAudit = makeMockAudit();
    const contractId = 'same-ms-contract';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(path.join(contractDir, 'progress.json'), '{broken', 'utf-8');
    await fs.writeFile(path.join(contractDir, 'contract.yaml'), 'schema_version: 1', 'utf-8');

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const r1 = await isolateCorruptedFile(nodeFs, mockAudit as any, {
      contractId,
      contractDir,
      filename: 'progress.json',
      reason: 'json_parse_error',
    });
    const r2 = await isolateCorruptedFile(nodeFs, mockAudit as any, {
      contractId,
      contractDir,
      filename: 'contract.yaml',
      reason: 'schema_invalid',
    });

    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.backupPath).not.toBe(r2!.backupPath);
  });
});

/**
 * Phase 959 — corruption isolation follow-up
 *
 * 1. isolation failure → markCrashed is NOT called
 * 2. YAML syntax error → enters isolation path
 * 3. existing backup path → retry with new UUID instead of overwrite
 */
describe('Phase 959 corruption isolation follow-up', () => {
  const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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
