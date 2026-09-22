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
import { readArchivePayload, projectFailedFailure } from '../../../src/core/contract/archive-reader.js';
import type { PersistedContractYaml, ContractLocation, ArchiveState } from '../../../src/core/contract/types.js';

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

/**
 * Flat payload (contract.yaml + progress.json) at the current path form
 * `archive/<state>/<id>` — what the live writer (active dir move) produces.
 */
async function writeFlatCurrentArchive(
  state: ArchiveState,
  contract: PersistedContractYaml,
  progress: Record<string, unknown>,
): Promise<string> {
  const root = path.join(clawDir, 'contract', 'archive', state, contractId);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'contract.yaml'), yaml.dump(contract), 'utf-8');
  await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify(progress), 'utf-8');
  return `contract/archive/${state}/${contractId}`;
}

/** Strict payload (subtasks/*.json) — no writer since Phase 1193 Step A; rejected on read. */
async function writeStrictArchive(
  state: ArchiveState,
  contract: PersistedContractYaml,
  records: Record<string, unknown>,
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

function currentLocation(state: ArchiveState, root: string): Extract<ContractLocation, { kind: 'archived-current' }> {
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

describe('readArchivePayload unsupported subtasks/ layout (Phase 1898)', () => {
  it('rejects a completed subtasks/ archive with unsupported_layout', async () => {
    const root = await writeStrictArchive('completed', makeContract(), {
      t1: { schema_version: 1, subtask_id: 't1', status: 'completed', attempts: [], completed_at: '2026-07-19T10:00:00Z' },
    });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('unsupported_layout');
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toHaveLength(1);
  });

  it('rejects a cancelled subtasks/ archive with unsupported_layout', async () => {
    const root = await writeStrictArchive('cancelled', makeContract(), {
      t1: { schema_version: 1, subtask_id: 't1', status: 'todo', attempts: [] },
    });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('cancelled', root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('unsupported_layout');
  });

  it('rejects a failed subtasks/ archive with unsupported_layout', async () => {
    const root = await writeStrictArchive('failed', makeContract(), {
      t1: { schema_version: 1, subtask_id: 't1', status: 'todo', attempts: [] },
    });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('failed', root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('unsupported_layout');
  });

  it('rejects without attempting to parse subtask record contents', async () => {
    const root = await writeStrictArchive('completed', makeContract(), { t1: 'not-even-an-object' });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('unsupported_layout');
  });

  it('rejects a subtasks/ archive regardless of contract.yaml validity', async () => {
    const root = await writeStrictArchive('completed', { ...makeContract(), id: 'cid-wrong' }, {
      t1: { schema_version: 1, subtask_id: 't1', status: 'todo', attempts: [] },
    });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
    });

    expect(result.kind).toBe('issue');
    if (result.kind !== 'issue') return;
    expect(result.issue.code).toBe('unsupported_layout');
  });
});

describe('readArchivePayload flat layout', () => {
  it('returns verified payload view for flat archive', async () => {
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
    expect(result.view.contract.id).toBe(contractId);
    expect(result.view.progress.status).toBe('completed');
    expect(result.view.progress.subtasks.t1.status).toBe('completed');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(false);
  });

  it('maps flat progress running status to in_progress', async () => {
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


describe('readArchivePayload lifecycle intents (Phase 1198 Step A)', () => {
  it('returns empty intents for archive without intent store', async () => {
    const root = await writeFlatCurrentArchive('completed', makeContract(), {
      schema_version: 1,
      subtasks: { t1: { status: 'completed', completed_at: '2026-07-19T10:00:00Z' } },
    });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
      baseDir: clawDir,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.view.intents).toEqual([]);
    expect(result.view.intentIssues).toEqual([]);
  });

  it('returns intents associated with current archive', async () => {
    const root = await writeFlatCurrentArchive('cancelled', makeContract(), {
      schema_version: 1,
      subtasks: { t1: { status: 'pending' } },
    });
    const { audit } = makeAudit();
    const intentPath = path.join(clawDir, 'contract', 'lifecycle-intents', contractId, 'req-1.json');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(
      intentPath,
      JSON.stringify({
        schema_version: 1,
        request_id: 'req-1',
        contract_id: contractId,
        requested_state: 'cancelled',
        requested_at: new Date().toISOString(),
        reason: 'user cancelled',
      }),
      'utf-8',
    );

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('cancelled', root),
      contractId,
      baseDir: clawDir,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.view.intents).toHaveLength(1);
    expect(result.view.intents[0].requested_state).toBe('cancelled');
    expect((result.view.intents[0] as { reason: string }).reason).toBe('user cancelled');
  });

  it('returns empty intents for markerless legacy archive (legacy fallback)', async () => {
    const root = await writeLegacyArchive(makeContract(), {
      schema_version: 1,
      subtasks: { t1: { status: 'completed', completed_at: '2026-07-19T10:00:00Z' } },
    });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: legacyLocation(root),
      contractId,
      baseDir: clawDir,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.view.intents).toEqual([]);
    expect(result.view.intentIssues).toEqual([]);
  });

  it('reports malformed intent without hiding valid payload', async () => {
    const root = await writeFlatCurrentArchive('completed', makeContract(), {
      schema_version: 1,
      subtasks: { t1: { status: 'completed', completed_at: '2026-07-19T10:00:00Z' } },
    });
    const { audit, events } = makeAudit();
    const intentDir = path.join(clawDir, 'contract', 'lifecycle-intents', contractId);
    await fs.mkdir(intentDir, { recursive: true });
    await fs.writeFile(path.join(intentDir, 'bad.json'), '{broken', 'utf-8');

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('completed', root),
      contractId,
      baseDir: clawDir,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.view.intents).toEqual([]);
    expect(result.view.intentIssues).toHaveLength(1);
    expect(result.view.intentIssues[0].reason).toBe('parse_failed');
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.LIFECYCLE_INTENT_READ_ISSUE)).toBe(true);
  });
});

describe('readArchivePayload failed state (Phase 1396 Step D)', () => {
  it('returns verified payload view for failed archive (flat read: state unresolved)', async () => {
    const root = await writeFlatCurrentArchive('failed', makeContract(), {
      schema_version: 1,
      subtasks: { t1: { status: 'pending' } },
    });
    const { audit, events } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('failed', root),
      contractId,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.ARCHIVE_PAYLOAD_READ_ISSUE)).toBe(false);
  });

  it('projects the failure fact from failed intents', async () => {
    const root = await writeFlatCurrentArchive('failed', makeContract(), {
      schema_version: 1,
      subtasks: { t1: { status: 'pending' } },
    });
    const { audit } = makeAudit();
    const intentPath = path.join(clawDir, 'contract', 'lifecycle-intents', contractId, 'req-f.json');
    await fs.mkdir(path.dirname(intentPath), { recursive: true });
    await fs.writeFile(
      intentPath,
      JSON.stringify({
        schema_version: 1,
        request_id: 'req-f',
        contract_id: contractId,
        requested_state: 'failed',
        requested_at: new Date().toISOString(),
        failure: {
          reason: 'executor died',
          evidenceRef: 'executor/events.jsonl#seq=42',
          producer: 'event-loop',
        },
      }),
      'utf-8',
    );

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('failed', root),
      contractId,
      baseDir: clawDir,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    const failure = projectFailedFailure(result.view);
    expect(failure).toEqual({
      reason: 'executor died',
      evidenceRef: 'executor/events.jsonl#seq=42',
      producer: 'event-loop',
      source: 'intent',
    });
  });

  it('returns null failure projection when no failed intent exists', async () => {
    const root = await writeFlatCurrentArchive('failed', makeContract(), {
      schema_version: 1,
      subtasks: { t1: { status: 'pending' } },
    });
    const { audit } = makeAudit();

    const result = await readArchivePayload({
      fs: nodeFs,
      audit,
      location: currentLocation('failed', root),
      contractId,
      baseDir: clawDir,
    });

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(projectFailedFailure(result.view)).toBeNull();
  });
});
