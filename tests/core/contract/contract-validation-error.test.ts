/**
 * ContractValidationError tests (phase 67 Step D)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { ContractValidationError } from '../../../src/core/contract/errors.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeAudit } from '../../helpers/audit.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-contract-validation-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
});

function setupManager() {
  const { audit } = makeAudit();
  return new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit,
    toolRegistry: createToolRegistry(),
    fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
    clawsDir: '/tmp/test/claws',
    notifyClaw: () => {},});
}

describe('ContractValidationError (phase 67)', () => {
  it('id empty → field=id kind=empty', async () => {
    const manager = setupManager();
    await expect(
      manager.create(makeContractYaml({ id: '' })),
    ).rejects.toThrow(ContractValidationError);

    try {
      await manager.create(makeContractYaml({ id: '' }));
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.field).toBe('id');
      expect(e.kind).toBe('empty');
      expect(e.message).toContain('contract id must not be empty');
    }
  });

  it('id already exists in archive → field=id kind=already_exists', async () => {
    const manager = setupManager();
    const yaml = makeContractYaml({ id: 'dup-id' });
    // 模拟 archive 中已存在同名 contract
    await fs.mkdir(path.join(clawDir, 'contract', 'archive', 'dup-id'), { recursive: true });

    await expect(manager.create(yaml)).rejects.toThrow(ContractValidationError);

    try {
      await manager.create(yaml);
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.field).toBe('id');
      expect(e.kind).toBe('already_exists');
      expect(e.context?.contractId).toBe('dup-id');
    }
  });

  it('no subtasks → field=subtasks kind=missing', async () => {
    const manager = setupManager();
    await expect(
      manager.create(makeContractYaml({ subtasks: [] })),
    ).rejects.toThrow(ContractValidationError);

    try {
      await manager.create(makeContractYaml({ subtasks: [] }));
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.field).toBe('subtasks');
      expect(e.kind).toBe('missing');
    }
  });

  it('verification script missing script_file → field=verification kind=config_missing_field', async () => {
    const manager = setupManager();
    await expect(
      manager.create(makeContractYaml({
        verification: [{ subtask_id: 'task-1', type: 'script' } as any],
      })),
    ).rejects.toThrow(ContractValidationError);

    try {
      await manager.create(makeContractYaml({
        verification: [{ subtask_id: 'task-1', type: 'script' } as any],
      }));
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.field).toBe('verification');
      expect(e.kind).toBe('config_missing_field');
      expect(e.context?.subtaskId).toBe('task-1');
      expect(e.context?.configType).toBe('script');
      expect(e.context?.missingField).toBe('script_file');
    }
  });

  it('verification llm missing prompt_file → field=verification kind=config_missing_field', async () => {
    const manager = setupManager();
    await expect(
      manager.create(makeContractYaml({
        verification: [{ subtask_id: 'task-1', type: 'llm' } as any],
      })),
    ).rejects.toThrow(ContractValidationError);

    try {
      await manager.create(makeContractYaml({
        verification: [{ subtask_id: 'task-1', type: 'llm' } as any],
      }));
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.field).toBe('verification');
      expect(e.kind).toBe('config_missing_field');
      expect(e.context?.subtaskId).toBe('task-1');
      expect(e.context?.configType).toBe('llm');
      expect(e.context?.missingField).toBe('prompt_file');
    }
  });

  it('verification duplicate subtask_id → field=verification kind=duplicate', async () => {
    const manager = setupManager();
    await expect(
      manager.create(makeContractYaml({
        verification: [
          { subtask_id: 'task-1', type: 'script', script_file: 'v1.sh' },
          { subtask_id: 'task-1', type: 'script', script_file: 'v2.sh' },
        ],
      })),
    ).rejects.toThrow(ContractValidationError);

    try {
      await manager.create(makeContractYaml({
        verification: [
          { subtask_id: 'task-1', type: 'script', script_file: 'v1.sh' },
          { subtask_id: 'task-1', type: 'script', script_file: 'v2.sh' },
        ],
      }));
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.field).toBe('verification');
      expect(e.kind).toBe('duplicate');
      expect(e.context?.subtaskId).toBe('task-1');
    }
  });
});
