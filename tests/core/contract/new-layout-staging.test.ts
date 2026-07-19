/**
 * Phase 1134 Step D: staging prepare, exclusive commit and abandoned cleanup tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'os';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import {
  prepareContractStaging,
  commitContractStaging,
  cleanupAbandonedContractStaging,
  readCurrentContractLayout,
} from '../../../src/core/contract/new-layout.js';
import {
  ActiveContractSlotOccupiedError,
  ContractStagingCorruptedError,
} from '../../../src/core/contract/errors.js';
import type { PersistedContractYaml } from '../../../src/core/contract/types.js';

let tmpDir: string;
let clawDir: string;
let nodeFs: NodeFileSystem;

beforeEach(async () => {
  tmpDir = path.join(
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    os.tmpdir(),
    `.test-new-layout-staging-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  clawDir = path.join(tmpDir, 'claws', 'test-claw');
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
  await fs.mkdir(clawDir, { recursive: true });
  nodeFs = new NodeFileSystem({ baseDir: clawDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* silent */ });
});

function makeContract(subtasks: Array<{ id: string; description: string }> = [{ id: 't1', description: 'D1' }]):
  PersistedContractYaml {
  return {
    schema_version: 1,
    id: 'cid-1',
    title: 'Test Contract',
    goal: 'Test goal',
    subtasks,
  };
}

describe('prepareContractStaging', () => {
  it('writes contract.yaml and todo subtask files', async () => {
    const { audit } = makeAudit();
    const prepared = await prepareContractStaging(
      { fs: nodeFs, audit },
      { creationId: 'create-1', contract: makeContract() },
    );

    expect(prepared.creationId).toBe('create-1');
    expect(prepared.root).toBe('contract/staging/create-1');

    const rootAbs = path.join(clawDir, prepared.root);
    const yamlRaw = await fs.readFile(path.join(rootAbs, 'contract.yaml'), 'utf-8');
    expect(yamlRaw).toContain('id: cid-1');

    const subtaskRaw = await fs.readFile(path.join(rootAbs, 'subtasks', 't1.json'), 'utf-8');
    const subtask = JSON.parse(subtaskRaw);
    expect(subtask.status).toBe('todo');
    expect(subtask.subtask_id).toBe('t1');
  });

  it('rejects invalid persisted contract yaml', async () => {
    const { audit } = makeAudit();
    const badContract = { ...makeContract(), id: '' } as PersistedContractYaml;
    await expect(
      prepareContractStaging({ fs: nodeFs, audit }, { creationId: 'create-bad', contract: badContract }),
    ).rejects.toBeInstanceOf(ContractStagingCorruptedError);
  });

  it('rejects duplicate creationId', async () => {
    const { audit } = makeAudit();
    await prepareContractStaging({ fs: nodeFs, audit }, { creationId: 'create-dup', contract: makeContract() });
    await expect(
      prepareContractStaging({ fs: nodeFs, audit }, { creationId: 'create-dup', contract: makeContract() }),
    ).rejects.toBeInstanceOf(ContractStagingCorruptedError);
  });
});

describe('commitContractStaging', () => {
  it('moves staging to active/current and readback succeeds', async () => {
    const { audit } = makeAudit();
    const prepared = await prepareContractStaging(
      { fs: nodeFs, audit },
      { creationId: 'create-1', contract: makeContract() },
    );

    await commitContractStaging({ fs: nodeFs, audit }, prepared);

    const layout = await readCurrentContractLayout({ fs: nodeFs, audit });
    expect(layout).not.toBeNull();
    expect(layout!.contract.id).toBe('cid-1');
    expect(layout!.subtasks.has('t1')).toBe(true);

    const stagingAbs = path.join(clawDir, prepared.root);
    expect(await fs.stat(stagingAbs).catch(() => null)).toBeNull();
  });

  it('rejects commit when active/current is already occupied', async () => {
    const { audit } = makeAudit();
    const first = await prepareContractStaging(
      { fs: nodeFs, audit },
      { creationId: 'first', contract: makeContract() },
    );
    const second = await prepareContractStaging(
      { fs: nodeFs, audit },
      { creationId: 'second', contract: makeContract() },
    );

    await commitContractStaging({ fs: nodeFs, audit }, first);

    await expect(
      commitContractStaging({ fs: nodeFs, audit }, second),
    ).rejects.toBeInstanceOf(ActiveContractSlotOccupiedError);

    // Current content remains the first commit.
    const layout = await readCurrentContractLayout({ fs: nodeFs, audit });
    expect(layout).not.toBeNull();
    expect(layout!.contract.id).toBe('cid-1');
  });
});

describe('cleanupAbandonedContractStaging', () => {
  it('removes abandoned staging directories', async () => {
    const { audit } = makeAudit();
    await prepareContractStaging({ fs: nodeFs, audit }, { creationId: 'abandoned-1', contract: makeContract() });
    await prepareContractStaging({ fs: nodeFs, audit }, { creationId: 'abandoned-2', contract: makeContract() });

    const result = await cleanupAbandonedContractStaging({ fs: nodeFs, audit });

    expect(result.removed.sort()).toEqual(['abandoned-1', 'abandoned-2']);
    expect(result.failed).toEqual([]);

    const stagingAbs = path.join(clawDir, 'contract', 'staging');
    expect((await fs.readdir(stagingAbs)).length).toBe(0);
  });

  it('reports non-directory entries without deleting them', async () => {
    const { audit, events } = makeAudit();
    const stagingAbs = path.join(clawDir, 'contract', 'staging');
    await fs.mkdir(stagingAbs, { recursive: true });
    await fs.writeFile(path.join(stagingAbs, 'not-a-dir.txt'), 'oops', 'utf-8');

    const result = await cleanupAbandonedContractStaging({ fs: nodeFs, audit });

    expect(result.removed).toEqual([]);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].creationId).toBe('not-a-dir.txt');
    expect(await fs.stat(path.join(stagingAbs, 'not-a-dir.txt')).catch(() => null)).not.toBeNull();
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.LAYOUT_CORRUPTED)).toBe(true);
  });
});

describe('concurrent commit with real NodeFileSystem', () => {
  it('has exactly one winner and one typed occupied loser without overwriting winner', async () => {
    const { audit: auditA } = makeAudit();
    const { audit: auditB } = makeAudit();
    const contractA = makeContract();
    const contractB: PersistedContractYaml = {
      ...makeContract(),
      id: 'cid-2',
      title: 'Contract B',
    };

    const preparedA = await prepareContractStaging(
      { fs: nodeFs, audit: auditA },
      { creationId: 'winner', contract: contractA },
    );
    const preparedB = await prepareContractStaging(
      { fs: nodeFs, audit: auditB },
      { creationId: 'loser', contract: contractB },
    );

    const [resultA, resultB] = await Promise.allSettled([
      commitContractStaging({ fs: nodeFs, audit: auditA }, preparedA),
      commitContractStaging({ fs: nodeFs, audit: auditB }, preparedB),
    ]);

    const statuses = [resultA.status, resultB.status];
    expect(statuses.filter(s => s === 'fulfilled').length).toBe(1);
    expect(statuses.filter(s => s === 'rejected').length).toBe(1);

    const rejected = resultA.status === 'rejected' ? resultA : resultB;
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ActiveContractSlotOccupiedError);

    const layout = await readCurrentContractLayout({ fs: nodeFs, audit: auditA });
    expect(layout).not.toBeNull();
    // Winner content must still be present; loser did not overwrite.
    const winnerContractId = resultA.status === 'fulfilled' ? contractA.id : contractB.id;
    expect(layout!.contract.id).toBe(winnerContractId);

    // Loser staging remains for explicit cleanup.
    const loserPrepared = resultA.status === 'rejected' ? preparedA : preparedB;
    expect(await fs.stat(path.join(clawDir, loserPrepared.root)).catch(() => null)).not.toBeNull();

    const cleanup = await cleanupAbandonedContractStaging({ fs: nodeFs, audit: auditA });
    expect(cleanup.removed.length).toBe(1);
    expect(await fs.stat(path.join(clawDir, loserPrepared.root)).catch(() => null)).toBeNull();
  });
});
