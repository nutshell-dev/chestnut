/**
 * Phase 1134 — progress.json schema_version invariant + legacy compatibility
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-progress-schema-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

describe('progress.json schema_version invariant — phase 1134', () => {
  it('getProgress rejects schema_version > CURRENT and emits PROGRESS_SCHEMA_INVALID', async () => {
    const mockAudit = makeMockAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // overwrite with schema_version too high
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(
      progressPath,
      JSON.stringify({ schema_version: 99, contract_id: contractId, status: 'running', subtasks: {} }),
      'utf-8',
    );

    const result = await manager.getProgress(contractId);
    expect(result).toBeNull();

    const calls = mockAudit.write.mock.calls;
    const versionCall = calls.find((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID);
    expect(versionCall).toBeDefined();
    expect(versionCall).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('path='),
        expect.stringContaining('reason=unknown_schema_version'),
        expect.stringContaining('actual=99'),
        expect.stringContaining('current=1'),
      ]),
    );
  });

  it('getProgress rejects legacy progress.json without schema_version (phase 319 strict-end)', async () => {
    const mockAudit = makeMockAudit();
    const manager = new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: mockAudit as any,
      toolRegistry: createToolRegistry(),
      fsFactory,
    clawsDir: '/tmp/test/claws',
    notifyClaw: vi.fn(),});

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    // phase 319 strict-end: legacy format (no schema_version) is now rejected by Zod
    // (mirror phase 311 ContractYaml strict pattern、ML#9 优先编译器检查)
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(
      progressPath,
      JSON.stringify({ contract_id: contractId, status: 'running', subtasks: { t1: { status: 'todo' } } }),
      'utf-8',
    );

    const progress = await manager.getProgress(contractId);
    expect(progress).toBeNull();

    // PROGRESS_SCHEMA_INVALID emit + isolation
    const badCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.PROGRESS_SCHEMA_INVALID,
    );
    expect(badCalls.length).toBeGreaterThan(0);
  });
});
