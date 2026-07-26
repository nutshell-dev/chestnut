/**
 * Phase 1193 Step C: archive current-format payload layout reader/projection tests.
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
  readStrictContractLayoutAtRoot,
  deriveContractAggregate,
  deriveSubtaskRetrySummary,
  projectArchivePayloadRuntime,
} from '../../../src/core/contract/archive-payload-layout.js';
import { ContractLayoutCorruptedError } from '../../../src/core/contract/errors.js';
import type { PersistedContractYaml, SubtaskRuntimeRecord } from '../../../src/core/contract/types.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-archive-payload-layout-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
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

async function writeArchivePayload(
  rootRelative: string,
  contract: PersistedContractYaml,
  records: Record<string, SubtaskRuntimeRecord>,
) {
  const root = path.join(clawDir, rootRelative);
  const subtasksDir = path.join(root, 'subtasks');
  await fs.mkdir(subtasksDir, { recursive: true });
  await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contract), 'utf-8');
  for (const [id, record] of Object.entries(records)) {
    await fs.writeFile(path.join(subtasksDir, `${id}.json`), JSON.stringify(record), 'utf-8');
  }
  return root;
}

describe('readStrictContractLayoutAtRoot', () => {
  it('reads valid layout and derives pending aggregate', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract(), { t1: makeTodoRecord('t1') });
    const { audit, events } = makeAudit();

    const result = await readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root);

    expect(result.root).toBe(root);
    expect(result.contract.id).toBe('cid-1');
    expect(result.subtasks.has('t1')).toBe(true);
    expect(result.aggregate).toBe('pending');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toBe(false);
  });

  it('derives running aggregate when any subtask is verifying', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract(), {
      t1: {
        schema_version: 1,
        subtask_id: 't1',
        status: 'verifying',
        current_attempt_id: 'a1',
        attempts: [
          {
            id: 'a1',
            status: 'running',
            started_at: '2026-07-19T10:00:00Z',
            evidence: 'ev',
            artifacts: [],
          },
        ],
      },
    });
    const { audit } = makeAudit();
    const result = await readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root);
    expect(result.aggregate).toBe('running');
  });

  it('derives completed aggregate when all subtasks completed', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract([
      { id: 't1', description: 'D1' },
      { id: 't2', description: 'D2' },
    ]), {
      t1: { schema_version: 1, subtask_id: 't1', status: 'completed', attempts: [], completed_at: '2026-07-19T10:00:00Z' },
      t2: { schema_version: 1, subtask_id: 't2', status: 'completed', attempts: [], completed_at: '2026-07-19T10:00:00Z' },
    });
    const { audit } = makeAudit();
    const result = await readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root);
    expect(result.aggregate).toBe('completed');
  });

  it('throws layout corruption for missing contract.yaml', async () => {
    const root = 'contract/archive/completed/cid-1';
    await fs.mkdir(path.join(clawDir, root, 'subtasks'), { recursive: true });
    const { audit, events } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toHaveLength(1);
  });

  it('throws layout corruption for invalid contract.yaml schema', async () => {
    const root = 'contract/archive/completed/cid-1';
    await fs.mkdir(path.join(clawDir, root), { recursive: true });
    await fs.writeFile(path.join(clawDir, root, 'contract.yaml'), yaml.dump({ schema_version: 1, title: 'no goal' }), 'utf-8');
    const { audit, events } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toHaveLength(1);
  });

  it('throws layout corruption when contract id mismatches expected', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract(), { t1: makeTodoRecord('t1') });
    const { audit, events } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root, 'cid-expected' as any)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toHaveLength(1);
  });

  it('throws layout corruption for missing subtasks dir', async () => {
    const root = 'contract/archive/completed/cid-1';
    await fs.mkdir(path.join(clawDir, root), { recursive: true });
    await fs.writeFile(path.join(clawDir, root, 'contract.yaml'), yaml.dump(makeContract()), 'utf-8');
    const { audit, events } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toBe(true);
  });

  it('throws layout corruption for missing subtask file', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract([{ id: 't1', description: 'D1' }, { id: 't2', description: 'D2' }]), { t1: makeTodoRecord('t1') });
    const { audit } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
  });

  it('throws layout corruption for extra subtask file', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract(), { t1: makeTodoRecord('t1'), t2: makeTodoRecord('t2') });
    const { audit } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
  });

  it('throws layout corruption for duplicate subtask ids in yaml', async () => {
    const contract: PersistedContractYaml = {
      ...makeContract(),
      subtasks: [
        { id: 't1', description: 'D1' },
        { id: 't1', description: 'D2' },
      ],
    };
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, contract, { t1: makeTodoRecord('t1') });
    const { audit } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
  });

  it('throws layout corruption for subtask id mismatch', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract(), {
      t1: { schema_version: 1, subtask_id: 't1-wrong', status: 'todo', attempts: [] },
    });
    const { audit } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
  });

  it('throws layout corruption for invalid subtask JSON', async () => {
    const root = 'contract/archive/completed/cid-1';
    const subtasksDir = path.join(clawDir, root, 'subtasks');
    await fs.mkdir(subtasksDir, { recursive: true });
    await fs.writeFile(path.join(clawDir, root, 'contract.yaml'), yaml.dump(makeContract()), 'utf-8');
    await fs.writeFile(path.join(subtasksDir, 't1.json'), 'not json', 'utf-8');
    const { audit } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
  });

  it('throws layout corruption for invalid subtask schema', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract(), {
      t1: { schema_version: 1, subtask_id: 't1', status: 'completed', attempts: [] } as SubtaskRuntimeRecord,
    });
    const { audit } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
  });

  it('throws layout corruption when subtasks contains a subdirectory', async () => {
    const root = 'contract/archive/completed/cid-1';
    const subtasksDir = path.join(clawDir, root, 'subtasks');
    await fs.mkdir(path.join(subtasksDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(clawDir, root, 'contract.yaml'), yaml.dump(makeContract()), 'utf-8');
    await fs.writeFile(path.join(subtasksDir, 't1.json'), JSON.stringify(makeTodoRecord('t1')), 'utf-8');
    const { audit } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
  });

  it('throws layout corruption for non-json file in subtasks', async () => {
    const root = 'contract/archive/completed/cid-1';
    const subtasksDir = path.join(clawDir, root, 'subtasks');
    await fs.mkdir(subtasksDir, { recursive: true });
    await fs.writeFile(path.join(clawDir, root, 'contract.yaml'), yaml.dump(makeContract()), 'utf-8');
    await fs.writeFile(path.join(subtasksDir, 't1.json'), JSON.stringify(makeTodoRecord('t1')), 'utf-8');
    await fs.writeFile(path.join(subtasksDir, 'notes.txt'), 'txt', 'utf-8');
    const { audit } = makeAudit();

    await expect(readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root)).rejects.toBeInstanceOf(ContractLayoutCorruptedError);
  });
});

describe('deriveSubtaskRetrySummary', () => {
  it('counts rejected attempts and ignores interrupted', () => {
    const record: SubtaskRuntimeRecord = {
      schema_version: 1,
      subtask_id: 't1',
      status: 'todo',
      attempts: [
        { id: 'a1', status: 'interrupted', started_at: '2026-07-19T10:00:00Z', evidence: 'ev', artifacts: [] },
        { id: 'a2', status: 'rejected', started_at: '2026-07-19T10:01:00Z', finished_at: '2026-07-19T10:02:00Z', evidence: 'ev', artifacts: [], feedback: 'bad', cause: 'llm_rejected' },
        { id: 'a3', status: 'rejected', started_at: '2026-07-19T10:03:00Z', finished_at: '2026-07-19T10:04:00Z', evidence: 'ev', artifacts: [] },
      ],
    };
    const summary = deriveSubtaskRetrySummary(record);
    expect(summary.retryCount).toBe(2);
    expect(summary.lastFailure!.attemptId).toBe('a3');
  });
});

describe('deriveContractAggregate', () => {
  it('empty map is pending', () => {
    expect(deriveContractAggregate(new Map())).toBe('pending');
  });
});

describe('projectArchivePayloadRuntime', () => {
  it('projects a completed payload into contract + progress', async () => {
    const root = 'contract/archive/completed/cid-1';
    await writeArchivePayload(root, makeContract(), {
      t1: { schema_version: 1, subtask_id: 't1', status: 'completed', attempts: [], completed_at: '2026-07-19T10:00:00Z' },
    });
    const { audit } = makeAudit();

    const layout = await readStrictContractLayoutAtRoot({ fs: nodeFs, audit }, root);
    const runtime = projectArchivePayloadRuntime(layout);

    expect(runtime.contract.id).toBe('cid-1');
    expect(runtime.progress.contract_id).toBe('cid-1');
    expect(runtime.progress.status).toBe('completed');
    expect(runtime.progress.subtasks.t1.status).toBe('completed');
  });
});
