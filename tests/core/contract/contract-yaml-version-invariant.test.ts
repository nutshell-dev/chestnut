import { describe, it, expect, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { loadContractYaml } from '../../../src/core/contract/persistence.js';

describe('phase 311: contract.yaml schema_version invariant (Zod literal(1))', () => {
  it('rejects contract.yaml with schema_version > 1', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpDir = path.join(os.tmpdir(), `.test-contract-version-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    const clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });

    const mockAudit = makeMockAudit();
    const contractId = 'version-test';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      'schema_version: 999\ntitle: Test\ngoal: Test\nsubtasks:\n  - id: t1\n    description: T1\n',
      'utf-8',
    );

    const ctx = {
      fs: nodeFs,
      audit: mockAudit as any,
      contractDir: async () => 'contract/active',
      getProgress: async () => ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
    };

    const result = await loadContractYaml(ctx, contractId);
    expect(result).toBeNull();
    const calls = mockAudit.write.mock.calls;
    const versionCall = calls.find((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID);
    expect(versionCall).toBeDefined();
    expect(versionCall).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('reason=schema_invalid'),
      ]),
    );

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  it('rejects contract.yaml with missing schema_version', async () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const tmpDir = path.join(os.tmpdir(), `.test-contract-missing-version-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    const clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });

    const mockAudit = makeMockAudit();
    const contractId = 'missing-version-test';
    const contractDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(contractDir, { recursive: true });
    await fs.writeFile(
      path.join(contractDir, 'contract.yaml'),
      'title: Test\ngoal: Test\nsubtasks:\n  - id: t1\n    description: T1\n',
      'utf-8',
    );

    const ctx = {
      fs: nodeFs,
      audit: mockAudit as any,
      contractDir: async () => 'contract/active',
      getProgress: async () => ({ contract_id: contractId, status: 'running', subtasks: {} }) as any,
    };

    const result = await loadContractYaml(ctx, contractId);
    expect(result).toBeNull();
    const calls = mockAudit.write.mock.calls;
    const invalidCall = calls.find((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID);
    expect(invalidCall).toBeDefined();

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });
});
