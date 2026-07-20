/**
 * Phase 1145 Step B: archive payload reader tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { readArchivePayload } from '../../../src/core/contract/archive-reader.js';
import type { PersistedContractYaml, SubtaskRuntimeRecord, ContractLocation } from '../../../src/core/contract/types.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-archive-reader-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
});

const contractId = 'cid-1';

function makeContract(subtasks: Array<{ id: string; description: string }> = [{ id: 't1', description: 'D1' }]): PersistedContractYaml {
  return {
    schema_version: 1,
    id: contractId,
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

function makeCompletedRecord(subtaskId: string): SubtaskRuntimeRecord {
  return {
    schema_version: 1,
    subtask_id: subtaskId,
    status: 'completed',
    attempts: [],
    completed_at: '2026-07-19T10:00:00Z',
  };
}

async function writeCurrentArchive(
  state: 'completed' | 'cancelled' | 'corrupted',
  contract: PersistedContractYaml,
  records: Record<string, SubtaskRuntimeRecord>,
): Promise<string> {
  const root = path.join(clawDir, 'contract', 'archive', state, contractId);
  const subtasksDir = path.join(root, 'subtasks');
  await fs.mkdir(subtasksDir, { recursive: true });
  await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contract), 'utf-8');
  for (const [id, record] of Object.entries(records)) {
    await fs.writeFile(path.join(subtasksDir, `${id}.json`), JSON.stringify(record), 'utf-8');
  }
  return `contract/archive/${state}/${contractId}`;
}

async function writeLegacyArchive(
  contract: PersistedContractYaml,
  progress: Record<string, unknown>,
): Promise<string> {
  const root = path.join(clawDir, 'contract', 'archive', contractId);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contract), 'utf-8');
  await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify(progress), 'utf-8');
  return `contract/archive/${contractId}`;
}

function currentLocation(state: 'completed' | 'cancelled' | 'corrupted', root: string): Extract<ContractLocation, { kind: 'archived-current' }> {
  return {
    kind: 'archived-current',
    state,
    containerDir: `contract/archive/${state}`,
    contractRoot: root,
  };
}

function legacyLocation(root: string): Extract<ContractLocation, { kind: 'archived-legacy' }> {
  return {
    kind: 'archived-legacy',
    containerDir: 'contract/archive',
    contractRoot: root,
  };
}

describe('readArchivePayload current layout', () => {
  it('returns verified payload view for completed current archive', async () => {
    const root = await writeCurrentArchive('completed', makeContract(), { t1: makeCompletedRecord('t1') });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.view.layout).toBe('current');
    expect(result.view.state).toBe('completed');
    expect(result.view.contract.id).toBe(contractId);
    expect(result.view.progress.contract_id).toBe(contractId);
    expect(result.view.progress.status).toBe('completed');
    expect(result.view.progress.subtasks.t1.status).toBe('completed');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(false);
  });

  it('maps current archive state from location', async () => {
    const root = await writeCurrentArchive('cancelled', makeContract(), { t1: makeTodoRecord('t1') });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('cancelled', root),
      contractId,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.view.state).toBe('cancelled');
    expect(result.view.progress.status).toBe('pending');
  });

  it('returns layout_corrupted issue for current archive with missing subtask file', async () => {
    const root = await writeCurrentArchive('completed', makeContract([{ id: 't1', description: 'D1' }, { id: 't2', description: 'D2' }]), { t1: makeTodoRecord('t1') });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('layout_corrupted');
    // Strict reader already audited LAYOUT_CORRUPTED; archive reader must not double-emit.
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toHaveLength(0);
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toBe(true);
  });

  it('returns layout_corrupted issue for current archive with unexpected subtask file', async () => {
    const root = await writeCurrentArchive('completed', makeContract(), { t1: makeTodoRecord('t1'), t2: makeTodoRecord('t2') });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('layout_corrupted');
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toHaveLength(0);
  });

  it('returns layout_corrupted issue for current archive with yaml id mismatch', async () => {
    const root = await writeCurrentArchive('completed', { ...makeContract(), id: 'cid-wrong' }, { t1: makeTodoRecord('t1') });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('layout_corrupted');
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toHaveLength(0);
  });
});

describe('readArchivePayload legacy layout', () => {
  it('returns verified payload view for legacy flat archive', async () => {
    const root = await writeLegacyArchive(makeContract(), {
      schema_version: 1,
      subtasks: {
        t1: { status: 'completed', completed_at: '2026-07-19T10:00:00Z' },
      },
    });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.view.layout).toBe('legacy');
    expect(result.view.state).toBe('legacy-unresolved');
    expect(result.view.contract.id).toBe(contractId);
    expect(result.view.progress.status).toBe('completed');
    expect(result.view.progress.subtasks.t1.status).toBe('completed');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(false);
  });

  it('maps legacy running status to in_progress', async () => {
    const root = await writeLegacyArchive(makeContract(), {
      schema_version: 1,
      subtasks: {
        t1: { status: 'running', verification_attempt_id: 'a1' },
      },
    });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.view.progress.subtasks.t1.status).toBe('in_progress');
  });

  it('returns yaml_missing issue when contract.yaml is absent in legacy root', async () => {
    const root = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ schema_version: 1, subtasks: {} }), 'utf-8');
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('yaml_missing');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });

  it('returns yaml_parse_error issue for malformed contract.yaml', async () => {
    const root = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'contract.yaml'), 'not: [yaml', 'utf-8');
    await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ schema_version: 1, subtasks: {} }), 'utf-8');
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('yaml_parse_error');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });

  it('returns yaml_schema_invalid issue for invalid contract.yaml', async () => {
    const root = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump({ schema_version: 1, title: 'no goal' }), 'utf-8');
    await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ schema_version: 1, subtasks: {} }), 'utf-8');
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('yaml_schema_invalid');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });

  it('returns yaml_id_mismatch issue when contract.yaml id differs', async () => {
    const root = await writeLegacyArchive({ ...makeContract(), id: 'cid-wrong' }, {
      schema_version: 1,
      subtasks: {},
    });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('yaml_id_mismatch');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });

  it('returns progress_parse_error issue for malformed progress.json', async () => {
    const root = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(makeContract()), 'utf-8');
    await fs.writeFile(path.join(root, 'progress.json'), '{broken', 'utf-8');
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('progress_parse_error');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });

  it('returns progress_schema_invalid issue for invalid progress.json', async () => {
    const root = await writeLegacyArchive(makeContract(), {
      schema_version: 2,
      subtasks: {},
    });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('progress_schema_invalid');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });

  it('returns progress_projection_failed issue for unrecognised subtask status', async () => {
    const root = await writeLegacyArchive(makeContract(), {
      schema_version: 1,
      subtasks: {
        t1: { status: 'crashed' },
      },
    });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('progress_projection_failed');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });

  it('returns entry_disappeared issue when progress.json vanishes after layout detection', async () => {
    const root = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(makeContract()), 'utf-8');
    await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ schema_version: 1, subtasks: {} }), 'utf-8');

    // Use a filesystem that reports progress.json exists but then throws ENOENT on read.
    const { audit, events } = makeAudit();
    const fsProxy = new Proxy(nodeFs, {
      get(target, prop) {
        if (prop === 'read') {
          return async (filePath: string) => {
            if (filePath.includes('progress.json')) {
              const err = new Error('ENOENT') as NodeJS.ErrnoException;
              err.code = 'ENOENT';
              throw err;
            }
            return (target.read as (p: string) => Promise<string>)(filePath);
          };
        }
        return (target as Record<string, unknown>)[prop as string];
      },
    });

    const result = await readArchivePayload({
      fs: fsProxy as typeof nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('entry_disappeared');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });
});

describe('readArchivePayload layout detection', () => {
  it('returns ambiguous_layout when both subtasks/ and progress.json exist', async () => {
    const root = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    await fs.mkdir(path.join(root, 'subtasks'), { recursive: true });
    await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(makeContract()), 'utf-8');
    await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ schema_version: 1, subtasks: {} }), 'utf-8');
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', `contract/archive/completed/${contractId}`),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('ambiguous_layout');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });

  it('returns missing_payload when neither subtasks/ nor progress.json exist', async () => {
    const root = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    await fs.mkdir(root, { recursive: true });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', `contract/archive/completed/${contractId}`),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('missing_payload');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(true);
  });
});
