import { describe, it, expect, vi } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { loadContractYaml } from '../../../src/core/contract/persistence.js';

describe('phase 1019 r124 E fork: contract.yaml schema_version invariant', () => {
  it('rejects contract.yaml with schema_version > CONTRACT_CURRENT_SCHEMA_VERSION', async () => {
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

    await expect(loadContractYaml(ctx, contractId)).rejects.toThrow(/unknown schema_version/);
    const calls = mockAudit.write.mock.calls;
    const versionCall = calls.find((c: any[]) => c[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID);
    expect(versionCall).toBeDefined();
    expect(versionCall).toEqual(
      expect.arrayContaining([
        CONTRACT_AUDIT_EVENTS.CONTRACT_YAML_SCHEMA_INVALID,
        expect.stringContaining(`contractId=${contractId}`),
        expect.stringContaining('reason=unknown_schema_version'),
        expect.stringContaining('actual=999'),
        expect.stringContaining('current=1'),
      ]),
    );

    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });
});
