/**
 * Phase 1135: new-layout runtime access boundary tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import {
  resolveActiveContractLocation,
  type ActiveContractLocation,
} from '../../../src/core/contract/locations.js';
import { ContractLayoutCorruptedError } from '../../../src/core/contract/errors.js';
import type { PersistedContractYaml, SubtaskRuntimeRecord } from '../../../src/core/contract/types.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-new-layout-runtime-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
});

function makeContract(subtasks: Array<{ id: string; description: string }> = [{ id: 't1', description: 'D1' }]): PersistedContractYaml {
  return {
    schema_version: 1,
    id: 'cid-1',
    title: 'Test Contract',
    goal: 'Test goal',
    subtasks,
  };
}

function makeTodoRecord(subtaskId: string): SubtaskRuntimeRecord {
  return {
    schema_version: 1,
    subtask_id: subtaskId,
    status: 'todo',
    attempts: [],
  };
}

async function writeCurrentLayout(
  contract: PersistedContractYaml,
  records: Record<string, SubtaskRuntimeRecord>,
) {
  const root = path.join(clawDir, 'contract', 'active', 'current');
  const subtasksDir = path.join(root, 'subtasks');
  await fs.mkdir(subtasksDir, { recursive: true });
  await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contract), 'utf-8');
  for (const [id, record] of Object.entries(records)) {
    await fs.writeFile(path.join(subtasksDir, `${id}.json`), JSON.stringify(record), 'utf-8');
  }
}

async function writeLegacyLayout(contractId: string) {
  const root = path.join(clawDir, 'contract', 'active', contractId);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, 'progress.json'),
    JSON.stringify({ schema_version: 1, subtasks: { t1: { status: 'todo' } } }),
    'utf-8',
  );
}

describe('active location', () => {
  it('returns null when neither current nor legacy exists', async () => {
    const { audit } = makeAudit();
    const result = await resolveActiveContractLocation({
      fs: nodeFs,
      audit,
      activeDir: 'contract/active',
      contractId: 'cid-1' as any,
    });
    expect(result).toBeNull();
  });

  it('returns current when current exists and id matches', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    const { audit, events } = makeAudit();

    const result = await resolveActiveContractLocation({
      fs: nodeFs,
      audit,
      activeDir: 'contract/active',
      contractId: 'cid-1' as any,
    });

    expect(result).toEqual<ActiveContractLocation>({
      layout: 'current',
      contractId: 'cid-1' as any,
      contractRoot: 'contract/active/current',
    });
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toBe(false);
  });

  it('throws when current exists but id mismatches, even if legacy exists', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    await writeLegacyLayout('cid-2');
    const { audit, events } = makeAudit();

    await expect(
      resolveActiveContractLocation({
        fs: nodeFs,
        audit,
        activeDir: 'contract/active',
        contractId: 'cid-2' as any,
      }),
    ).rejects.toBeInstanceOf(ContractLayoutCorruptedError);

    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toBe(true);
  });

  it('throws when current directory exists but yaml is missing', async () => {
    const root = path.join(clawDir, 'contract', 'active', 'current');
    await fs.mkdir(path.join(root, 'subtasks'), { recursive: true });
    const { audit, events } = makeAudit();

    await expect(
      resolveActiveContractLocation({
        fs: nodeFs,
        audit,
        activeDir: 'contract/active',
        contractId: 'cid-1' as any,
      }),
    ).rejects.toBeInstanceOf(ContractLayoutCorruptedError);

    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toBe(true);
  });

  it('returns legacy when current is absent and legacy directory exists', async () => {
    await writeLegacyLayout('cid-1');
    const { audit } = makeAudit();

    const result = await resolveActiveContractLocation({
      fs: nodeFs,
      audit,
      activeDir: 'contract/active',
      contractId: 'cid-1' as any,
    });

    expect(result).toEqual<ActiveContractLocation>({
      layout: 'legacy',
      contractId: 'cid-1' as any,
      contractRoot: 'contract/active/cid-1',
    });
  });

  it('prefers current over legacy when both exist', async () => {
    await writeCurrentLayout(makeContract(), { t1: makeTodoRecord('t1') });
    await writeLegacyLayout('cid-1');
    const { audit } = makeAudit();

    const result = await resolveActiveContractLocation({
      fs: nodeFs,
      audit,
      activeDir: 'contract/active',
      contractId: 'cid-1' as any,
    });

    expect(result?.layout).toBe('current');
    expect(result?.contractRoot).toBe('contract/active/current');
  });
});
