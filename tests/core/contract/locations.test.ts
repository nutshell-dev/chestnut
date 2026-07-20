/**
 * Contract location helpers tests
 *
 * Phase 1130 Step B: physical active directory enumeration.
 * Phase 1145 Step A: directory-based contract location resolver.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'path';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeAudit } from '../../helpers/audit.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import {
  listPhysicalActiveContractIds,
  resolveContractLocation,
  resolveContractLocationSync,
} from '../../../src/core/contract/locations.js';
import { ContractLocationAmbiguityError } from '../../../src/core/contract/errors.js';

describe('listPhysicalActiveContractIds', () => {
  let tmpDir: string;
  let fsNode: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = await createTempDir('chestnut-locations-');
    fsNode = new NodeFileSystem({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir).catch(() => { /* silent: cleanup */ });
  });

  it('returns empty array when active dir does not exist', async () => {
    const result = await listPhysicalActiveContractIds({
      fs: fsNode,
      activeDir: 'contract/active',
    });
    expect(result).toEqual([]);
  });

  it('returns only direct child directories, sorted', async () => {
    await fs.mkdir(path.join(tmpDir, 'contract', 'active', 'c-beta'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'contract', 'active', 'c-alpha'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'contract', 'active', 'c-gamma'), { recursive: true });

    const result = await listPhysicalActiveContractIds({
      fs: fsNode,
      activeDir: 'contract/active',
    });

    expect(result).toEqual(['c-alpha', 'c-beta', 'c-gamma']);
  });

  it('ignores plain files and nested directories', async () => {
    const activeDir = path.join(tmpDir, 'contract', 'active');
    await fs.mkdir(activeDir, { recursive: true });
    await fs.mkdir(path.join(activeDir, 'c-real'), { recursive: true });
    await fs.writeFile(path.join(activeDir, 'not-a-dir.txt'), 'x');
    await fs.mkdir(path.join(activeDir, 'c-real', 'nested'), { recursive: true });

    const result = await listPhysicalActiveContractIds({
      fs: fsNode,
      activeDir: 'contract/active',
    });

    expect(result).toEqual(['c-real']);
  });

  it('returns directories without progress.json (corrupt or stray active entries)', async () => {
    const activeDir = path.join(tmpDir, 'contract', 'active');
    await fs.mkdir(path.join(activeDir, 'c-no-progress'), { recursive: true });
    await fs.mkdir(path.join(activeDir, 'c-with-progress'), { recursive: true });
    await fs.writeFile(path.join(activeDir, 'c-with-progress', 'progress.json'), '{}');

    const result = await listPhysicalActiveContractIds({
      fs: fsNode,
      activeDir: 'contract/active',
    });

    expect(result).toEqual(['c-no-progress', 'c-with-progress']);
  });

  it('propagates list errors instead of treating them as empty', async () => {
    const brokenFs = {
      ...fsNode,
      exists: async () => true,
      list: async () => {
        throw new Error('disk read failed');
      },
    };

    await expect(
      listPhysicalActiveContractIds({
        fs: brokenFs as unknown as NodeFileSystem,
        activeDir: 'contract/active',
      }),
    ).rejects.toThrow('disk read failed');
  });
});

describe('resolveContractLocation', () => {
  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = await createTempDir('chestnut-resolve-location-');
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir).catch(() => { /* silent: cleanup */ });
  });

  const contractId = 'cid-1';

  it('finds new-format archive root by directory existence', async () => {
    const root = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    await fs.mkdir(path.join(root, 'subtasks'), { recursive: true });

    const { audit } = makeAudit();
    const loc = await resolveContractLocation({
      fs: nodeFs,
      activeDir: 'contract/active',
      archiveDir: 'contract/archive',
      contractId,
      audit,
    });

    expect(loc).not.toBeNull();
    expect(loc!.kind).toBe('archived-current');
    expect(loc!.state).toBe('completed');
    expect(loc!.contractRoot).toBe(`contract/archive/completed/${contractId}`);
  });

  it('finds archive root missing payload so reader can report issue', async () => {
    const root = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    await fs.mkdir(root, { recursive: true });

    const { audit } = makeAudit();
    const loc = await resolveContractLocation({
      fs: nodeFs,
      activeDir: 'contract/active',
      archiveDir: 'contract/archive',
      contractId,
      audit,
    });

    expect(loc).not.toBeNull();
    expect(loc!.kind).toBe('archived-current');
    expect(loc!.contractRoot).toBe(`contract/archive/completed/${contractId}`);
  });

  it('finds legacy flat archive root by directory existence', async () => {
    const root = path.join(clawDir, 'contract', 'archive', contractId);
    await fs.mkdir(root, { recursive: true });

    const { audit } = makeAudit();
    const loc = await resolveContractLocation({
      fs: nodeFs,
      activeDir: 'contract/active',
      archiveDir: 'contract/archive',
      contractId,
      audit,
    });

    expect(loc).not.toBeNull();
    expect(loc!.kind).toBe('archived-legacy');
    expect(loc!.contractRoot).toBe(`contract/archive/${contractId}`);
  });

  it('returns null when no root exists', async () => {
    const { audit } = makeAudit();
    const loc = await resolveContractLocation({
      fs: nodeFs,
      activeDir: 'contract/active',
      archiveDir: 'contract/archive',
      contractId,
      audit,
    });

    expect(loc).toBeNull();
  });

  it('throws ambiguity when same id exists in multiple locations', async () => {
    const completedRoot = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    const cancelledRoot = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);
    await fs.mkdir(path.join(completedRoot, 'subtasks'), { recursive: true });
    await fs.mkdir(path.join(cancelledRoot, 'subtasks'), { recursive: true });

    const { audit, events } = makeAudit();
    await expect(resolveContractLocation({
      fs: nodeFs,
      activeDir: 'contract/active',
      archiveDir: 'contract/archive',
      contractId,
      audit,
    })).rejects.toThrow(ContractLocationAmbiguityError);

    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_MULTI_DIR)).toBe(true);
  });
});

describe('resolveContractLocationSync', () => {
  let tmpDir: string;
  let clawDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tmpDir = await createTempDir('chestnut-resolve-location-sync-');
    clawDir = path.join(tmpDir, 'claws', 'test-claw');
    await fs.mkdir(clawDir, { recursive: true });
    nodeFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir).catch(() => { /* silent: cleanup */ });
  });

  const contractId = 'cid-1';

  it('finds new-format archive root by directory existence', async () => {
    const root = path.join(clawDir, 'contract', 'archive', 'completed', contractId);
    await fs.mkdir(path.join(root, 'subtasks'), { recursive: true });

    const { audit } = makeAudit();
    const loc = resolveContractLocationSync({
      fs: nodeFs,
      activeDir: 'contract/active',
      archiveDir: 'contract/archive',
      contractId,
      audit,
    });

    expect(loc).not.toBeNull();
    expect(loc!.kind).toBe('archived-current');
    expect(loc!.state).toBe('completed');
  });

  it('returns null when no root exists', () => {
    const { audit } = makeAudit();
    const loc = resolveContractLocationSync({
      fs: nodeFs,
      activeDir: 'contract/active',
      archiveDir: 'contract/archive',
      contractId,
      audit,
    });

    expect(loc).toBeNull();
  });
});
