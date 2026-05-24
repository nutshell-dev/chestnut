/**
 * Phase 587 — contract dir JSON.parse / YAML.parse schema 校验 sweep 测试
 *
 * 覆盖 4 site:
 * - manager.ts getProgress
 * - persistence.ts loadContractYaml
 * - discovery.ts findLatestContract
 * - event-collector.ts collectContractEvents
 */
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { loadContractYaml } from '../../../src/core/contract/persistence.js';
import { loadActiveContract } from '../../../src/core/contract/discovery.js';
import { collectContractEvents } from '../../../src/core/contract/jobs/event-collector.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    os.tmpdir(),
    `.test-schema-sweep-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

// ============================================================================
// Site 1: manager.ts getProgress
// ============================================================================

describe('getProgress schema check', () => {
  it('throws on corrupt schema (missing contract_id)', async () => {
    const mockAudit = { write: vi.fn() };
    const manager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

    const contractId = await manager.create(makeContractYaml({
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
    }));

    // overwrite with schema-invalid JSON (parsable but missing required fields)
    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(progressPath, JSON.stringify({ foo: 'bar' }), 'utf-8');

    await expect(manager.getProgress(contractId)).rejects.toThrow(/schema invalid/);
    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_progress_schema_invalid',
      expect.stringContaining(`contractId=${contractId}`),
      expect.stringContaining('path='),
      expect.stringContaining('raw='),
    );
  });

  it('throws on null subtasks', async () => {
    const mockAudit = { write: vi.fn() };
    const manager = new ContractSystem(clawDir, 'test-claw', nodeFs, mockAudit as any, undefined, createToolRegistry());

    const contractId = await manager.create({
      schema_version: 1 as const,
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      acceptance: [],
      auth_level: 'auto' as const,
    });

    const progressPath = path.join(clawDir, 'contract', 'active', contractId, 'progress.json');
    await fs.writeFile(
      progressPath,
      JSON.stringify({ contract_id: contractId, status: 'active', subtasks: null }),
      'utf-8',
    );

    await expect(manager.getProgress(contractId)).rejects.toThrow(/schema invalid/);
    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_progress_schema_invalid',
      expect.stringContaining(`contractId=${contractId}`),
      expect.anything(),
      expect.anything(),
    );
  });
});

// ============================================================================
// Site 2: persistence.ts loadContractYaml
// ============================================================================

describe('loadContractYaml schema check', () => {
  it('throws on missing title', async () => {
    const mockAudit = { write: vi.fn() };
    const contractId = 'yaml-test';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      'goal: Test\nsubtasks:\n  - id: t1\n    description: T1\n',
      'utf-8',
    );
    // minimal progress so contractDir resolves
    await fs.writeFile(
      path.join(contractDir, 'progress.json'),
      JSON.stringify({ contract_id: contractId, status: 'running', subtasks: {} }),
      'utf-8',
    );

    const ctx = {
      fs: nodeFs,
      audit: mockAudit as any,
      contractDir: async () => 'contract/active',
      getProgress: async () => ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
    };

    await expect(loadContractYaml(ctx, contractId)).rejects.toThrow(/schema invalid/);
    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_yaml_schema_invalid',
      expect.stringContaining(`contractId=${contractId}`),
      expect.stringContaining('path='),
      expect.stringContaining('raw='),
    );
  });

  it('throws on null yaml result (empty file)', async () => {
    const mockAudit = { write: vi.fn() };
    const contractId = 'empty-yaml';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(path.join(contractDir, 'contract.yaml'), '', 'utf-8');
    await fs.writeFile(
      path.join(contractDir, 'progress.json'),
      JSON.stringify({ contract_id: contractId, status: 'running', subtasks: {} }),
      'utf-8',
    );

    const ctx = {
      fs: nodeFs,
      audit: mockAudit as any,
      contractDir: async () => 'contract/active',
      getProgress: async () => ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
    };

    await expect(loadContractYaml(ctx, contractId)).rejects.toThrow(/schema invalid/);
  });
});

// ============================================================================
// Site 3: discovery.ts findLatestContract
// ============================================================================

describe('discovery schema check', () => {
  it('gracefully skips corrupt schema and finds latest valid', async () => {
    const mockAudit = { write: vi.fn() };
    const activeDir = path.join(clawDir, 'contract', 'active');

    // Contract A: schema invalid (missing contract_id)
    const dirA = path.join(activeDir, 'contract-a');
    await fs.mkdir(dirA, { recursive: true });
    await fs.writeFile(
      path.join(dirA, 'progress.json'),
      JSON.stringify({ status: 'running', subtasks: {} }),
      'utf-8',
    );

    // Contract B: valid, started_at older
    const dirB = path.join(activeDir, 'contract-b');
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(
      path.join(dirB, 'progress.json'),
      JSON.stringify({ contract_id: 'contract-b', status: 'running', subtasks: {}, started_at: '2024-01-01T00:00:00Z' }),
      'utf-8',
    );

    // Contract C: valid, started_at newest
    const dirC = path.join(activeDir, 'contract-c');
    await fs.mkdir(dirC, { recursive: true });
    await fs.writeFile(
      path.join(dirC, 'progress.json'),
      JSON.stringify({ contract_id: 'contract-c', status: 'running', subtasks: {}, started_at: '2024-06-01T00:00:00Z' }),
      'utf-8',
    );

    const ctx = {
      fs: nodeFs,
      audit: mockAudit as any,
      loadContract: vi.fn(),
    };

    // loadActiveContract 内部会调用 loadContract，我们需要 mock
    ctx.loadContract.mockResolvedValue({ id: 'contract-c', status: 'running' });

    const result = await loadActiveContract(ctx, 'contract/active');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('contract-c');

    // contract-a 被 schema_invalid 跳过
    const schemaInvalidCall = mockAudit.write.mock.calls.find(
      (c: any[]) => c[0] === 'contract_progress_schema_invalid'
    );
    expect(schemaInvalidCall).toBeDefined();
    expect(schemaInvalidCall!).toEqual(expect.arrayContaining([
      'contract_progress_schema_invalid',
      expect.stringContaining('context=ContractSystem.loadActive'),
      expect.stringContaining('contractId=contract-a'),
      expect.stringContaining('path='),
    ]));
  });

  it('skips null subtasks via schema check', async () => {
    const mockAudit = { write: vi.fn() };
    const activeDir = path.join(clawDir, 'contract', 'active');

    const dirA = path.join(activeDir, 'contract-a');
    await fs.mkdir(dirA, { recursive: true });
    await fs.writeFile(
      path.join(dirA, 'progress.json'),
      JSON.stringify({ contract_id: 'contract-a', status: 'active', subtasks: null }),
      'utf-8',
    );

    const ctx = {
      fs: nodeFs,
      audit: mockAudit as any,
      loadContract: vi.fn(),
    };

    const result = await loadActiveContract(ctx, 'contract/active');
    expect(result).toBeNull();

    const schemaInvalidCalls = mockAudit.write.mock.calls.filter(
      (c: any[]) => c[0] === 'contract_progress_schema_invalid'
    );
    expect(schemaInvalidCalls).toHaveLength(1);
    expect(schemaInvalidCalls[0]).toEqual(expect.arrayContaining([
      'contract_progress_schema_invalid',
      expect.stringContaining('context=ContractSystem.loadActive'),
      expect.stringContaining('contractId=contract-a'),
    ]));
  });
});

// ============================================================================
// Site 4+5: event-collector.ts collectContractEvents
// ============================================================================

describe('event-collector schema check', () => {
  function makeFsWithContracts(scenarios: Array<{
    dir: 'archive' | 'active';
    name: string;
    progress: unknown;
  }>): FileSystem {
    const files = new Map<string, string>();
    const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();

    const archiveContracts = scenarios.filter(s => s.dir === 'archive');
    const activeContracts = scenarios.filter(s => s.dir === 'active');

    dirs.set(path.join(clawDir, 'contract', 'archive'), archiveContracts.map(s => ({ name: s.name, isDirectory: true, size: 0 })));
    dirs.set(path.join(clawDir, 'contract', 'active'), activeContracts.map(s => ({ name: s.name, isDirectory: true, size: 0 })));

    for (const s of scenarios) {
      const p = path.join(clawDir, 'contract', s.dir, s.name, 'progress.json');
      files.set(p, JSON.stringify(s.progress));
    }

    return {
      existsSync: (p: string) => dirs.has(p) || files.has(p),
      listSync: (p: string) => dirs.get(p) ?? [],
      readSync: (p: string) => {
        if (files.has(p)) return files.get(p)!;
        throw new Error('ENOENT');
      },
      ensureDirSync: () => {},
      writeAtomicSync: () => {},
    } as unknown as FileSystem;
  }

  it('skips archive contract with schema invalid progress.json', () => {
    const mockAudit = { write: vi.fn() };
    const fsMock = makeFsWithContracts([
      {
        dir: 'archive',
        name: 'bad',
        progress: { status: 'completed', subtasks: { t1: { completed_at: new Date().toISOString() } } }, // missing contract_id
      },
      {
        dir: 'archive',
        name: 'good',
        progress: {
          contract_id: 'good',
          status: 'completed',
          subtasks: { t1: { completed_at: new Date().toISOString() } },
        },
      },
    ]);

    const events = collectContractEvents(fsMock, clawDir, 'test-claw', 0, mockAudit as any);
    expect(events.length).toBe(1);
    expect(events[0]).toContain('contract=good');

    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_progress_schema_invalid',
      expect.stringContaining('clawId=test-claw'),
      expect.stringContaining('contract=bad'),
      expect.stringContaining('context=event_collector_archive'),
    );
  });

  it('skips active contract with null subtasks and audits PROGRESS_SCHEMA_INVALID', () => {
    const mockAudit = { write: vi.fn() };
    const now = Date.now();
    const fsMock = makeFsWithContracts([
      {
        dir: 'active',
        name: 'bad',
        progress: { contract_id: 'bad', status: 'active', subtasks: null },
      },
      {
        dir: 'active',
        name: 'good',
        progress: {
          contract_id: 'good',
          status: 'active',
          subtasks: {
            t1: { escalated_at: new Date(now + 1000).toISOString(), retry_count: 2 },
          },
        },
      },
    ]);

    const events = collectContractEvents(fsMock, clawDir, 'test-claw', now, mockAudit as any);
    expect(events.length).toBe(1);
    expect(events[0]).toContain('contract=good');

    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_progress_schema_invalid',
      expect.stringContaining('clawId=test-claw'),
      expect.stringContaining('contract=bad'),
      expect.stringContaining('context=event_collector_active'),
    );
  });

  it('audits PROGRESS_CORRUPTED on JSON.parse throw', () => {
    const mockAudit = { write: vi.fn() };
    const files = new Map<string, string>();
    const dirs = new Map<string, { name: string; isDirectory: boolean; size: number }[]>();

    dirs.set(path.join(clawDir, 'contract', 'archive'), [{ name: 'bad-json', isDirectory: true, size: 0 }]);
    files.set(path.join(clawDir, 'contract', 'archive', 'bad-json', 'progress.json'), '{ broken');

    const fsMock = {
      existsSync: (p: string) => dirs.has(p) || files.has(p),
      listSync: (p: string) => dirs.get(p) ?? [],
      readSync: (p: string) => {
        if (files.has(p)) return files.get(p)!;
        throw new Error('ENOENT');
      },
    } as unknown as FileSystem;

    const events = collectContractEvents(fsMock, clawDir, 'test-claw', 0, mockAudit as any);
    expect(events).toHaveLength(0);

    expect(mockAudit.write).toHaveBeenCalledWith(
      'contract_progress_corrupted',
      expect.stringContaining('clawId=test-claw'),
      expect.stringContaining('contract=bad-json'),
      expect.stringContaining('context=event_collector_archive'),
      expect.anything(),
    );
  });
});
