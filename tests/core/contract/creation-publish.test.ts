/**
 * Phase 1197 Step B: contract creation exclusive publish protocol tests.
 *
 * - deterministic cross-instance race
 * - publish boundary
 * - crash recovery from durable intent
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { CREATION_CLAIM_FILE } from '../../../src/core/contract/creation.js';

describe('Contract creation exclusive publish (Phase 1197 Step B)', () => {
  let testDir: string;
  let clawDir: string;

  beforeEach(async () => {
    testDir = path.join(
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-contract-creation-publish-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'claws', 'test-claw');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeManager(audit?: ReturnType<typeof makeAudit>['audit']) {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    const { audit: defaultAudit } = makeAudit();
    return new ContractSystem({
      clawDir,
      clawId: 'test-claw',
      fs: nodeFs,
      audit: audit ?? defaultAudit,
      toolRegistry: createToolRegistry(),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      clawsDir: '/tmp/test/claws',
      notifyClaw: vi.fn(),
    });
  }

  it('create writes .creating then deletes it after both payloads are persisted', async () => {
    const manager = makeManager();
    const contractId = 'published-contract';

    const id = await manager.create(makeContractYaml({
      id: contractId,
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    expect(id).toBe(contractId);

    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    await expect(fs.access(path.join(activeDir, 'contract.yaml'))).resolves.not.toThrow();
    await expect(fs.access(path.join(activeDir, 'progress.json'))).resolves.not.toThrow();
    await expect(fs.access(path.join(activeDir, CREATION_CLAIM_FILE))).rejects.toThrow();
  });

  it('duplicate id returns typed already_exists and does not touch winner payload', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'shared-id';

    await manager.create(makeContractYaml({
      id: contractId,
      title: 'First',
      goal: 'First',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [],
    }));

    const winnerYaml = await fs.readFile(path.join(clawDir, 'contract', 'active', contractId, 'contract.yaml'), 'utf-8');

    await expect(manager.create(makeContractYaml({
      id: contractId,
      title: 'Second',
      goal: 'Second',
      subtasks: [{ id: 't2', description: 'T2' }],
      verification: [],
    }))).rejects.toMatchObject({ field: 'id', kind: 'already_exists' });

    // Winner payload unchanged.
    expect(await fs.readFile(path.join(clawDir, 'contract', 'active', contractId, 'contract.yaml'), 'utf-8')).toBe(winnerYaml);

    // No second created audit.
    const createdEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CREATED);
    expect(createdEvents).toHaveLength(1);
  });

  it('concurrent cross-instance race has exactly one winner', async () => {
    const { audit: auditA, events: eventsA } = makeAudit();
    const { audit: auditB, events: eventsB } = makeAudit();
    const managerA = makeManager(auditA);
    const managerB = makeManager(auditB);
    const contractId = 'race-contract';

    // Both managers share the same physical clawDir, so they race on the same claim file.
    const results = await Promise.allSettled([
      managerA.create(makeContractYaml({
        id: contractId,
        title: 'A',
        goal: 'A',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      })),
      managerB.create(makeContractYaml({
        id: contractId,
        title: 'B',
        goal: 'B',
        subtasks: [{ id: 't1', description: 'T1' }],
        verification: [],
      })),
    ]);

    const winnerCount = results.filter(r => r.status === 'fulfilled').length;
    expect(winnerCount).toBe(1);

    const loserCount = results.filter(r => r.status === 'rejected').length;
    expect(loserCount).toBe(1);

    const createdCount = eventsA.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CREATED).length
      + eventsB.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CREATED).length;
    expect(createdCount).toBe(1);

    // Winner payload is not corrupted by loser.
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    const yamlRaw = await fs.readFile(path.join(activeDir, 'contract.yaml'), 'utf-8');
    expect(yamlRaw).toMatch(/title: (A|B)/);
  });

  it('boot init recovers an incomplete creation and preserves original started_at', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'recover-contract';
    const startedAt = '2026-07-12T10:00:00.000Z';

    // Manually seed an unpublished creation intent.
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(
      path.join(activeDir, CREATION_CLAIM_FILE),
      JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        started_at: startedAt,
        contract: makeContractYaml({
          id: contractId,
          title: 'Recovered',
          goal: 'Recovered',
          subtasks: [{ id: 't1', description: 'T1' }],
          verification: [],
        }),
      }, null, 2),
      'utf-8',
    );

    // Before init, normal consumers cannot see it.
    expect(await manager.getProgress(contractId)).toBeNull();

    await manager.init();

    // After recovery, it is published and readable.
    const progress = await manager.getProgress(contractId);
    expect(progress).not.toBeNull();
    expect(progress!.started_at).toBe(startedAt);
    await expect(fs.access(path.join(activeDir, CREATION_CLAIM_FILE))).rejects.toThrow();

    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERED)).toBe(true);
    const createdEvent = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.CREATED);
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.some(c => String(c).includes('recovered=true'))).toBe(true);
  });

  it('boot init leaves malformed intent unpublished and emits recovery_failed', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'malformed-recover';

    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, CREATION_CLAIM_FILE), '{ broken json', 'utf-8');

    await manager.init();

    // Still unpublished.
    expect(await manager.getProgress(contractId)).toBeNull();
    await expect(fs.access(path.join(activeDir, CREATION_CLAIM_FILE))).resolves.not.toThrow();

    const failedEvents = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED);
    expect(failedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('recovery is idempotent', async () => {
    const manager = makeManager();
    const contractId = 'idempotent-recover';

    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(
      path.join(activeDir, CREATION_CLAIM_FILE),
      JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        started_at: '2026-07-12T10:00:00.000Z',
        contract: makeContractYaml({
          id: contractId,
          title: 'Idempotent',
          goal: 'Idempotent',
          subtasks: [{ id: 't1', description: 'T1' }],
          verification: [],
        }),
      }, null, 2),
      'utf-8',
    );

    await manager.init();
    const progress1 = await manager.getProgress(contractId);
    expect(progress1).not.toBeNull();

    await manager.init();
    const progress2 = await manager.getProgress(contractId);
    expect(progress2).not.toBeNull();
    expect(progress2!.started_at).toBe(progress1!.started_at);
  });

  it('recovery skips publish when contract id collides with archive state (Phase 1197 Step C)', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'archive-collision-recover';
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    const collisionDir = path.join(clawDir, 'contract', 'archive', 'cancelled', contractId);

    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(
      path.join(activeDir, CREATION_CLAIM_FILE),
      JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        started_at: '2026-07-12T10:00:00.000Z',
        contract: makeContractYaml({
          id: contractId,
          title: 'Collision',
          goal: 'Collision',
          subtasks: [{ id: 't1', description: 'T1' }],
          verification: [],
        }),
      }, null, 2),
    );
    await fs.mkdir(collisionDir, { recursive: true });
    await fs.writeFile(path.join(collisionDir, 'contract.yaml'), 'schema_version: 1\nid: archive-collision-recover\ntitle: Archive\ngoal: Archive\nsubtasks:\n  - id: t1\n    description: D\n');

    await manager.init();

    // Active marker remains; active payloads are not materialized.
    await expect(fs.access(path.join(activeDir, CREATION_CLAIM_FILE))).resolves.not.toThrow();
    await expect(fs.access(path.join(activeDir, 'contract.yaml'))).rejects.toThrow();
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERED)).toBe(false);
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CREATED)).toBe(false);
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED && e.some(c => String(c).includes('reason=archive_collision')))).toHaveLength(1);
  });

  it('recovery skips publish when intent contract_id mismatches active path (Phase 1197 Step C)', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'intent-mismatch-recover';
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);

    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(
      path.join(activeDir, CREATION_CLAIM_FILE),
      JSON.stringify({
        schema_version: 1,
        contract_id: 'wrong-intent-id',
        started_at: '2026-07-12T10:00:00.000Z',
        contract: makeContractYaml({
          id: contractId,
          title: 'Mismatch',
          goal: 'Mismatch',
          subtasks: [{ id: 't1', description: 'T1' }],
          verification: [],
        }),
      }, null, 2),
    );

    await manager.init();

    expect(await manager.getProgress(contractId)).toBeNull();
    await expect(fs.access(path.join(activeDir, CREATION_CLAIM_FILE))).resolves.not.toThrow();
    await expect(fs.access(path.join(activeDir, 'contract.yaml'))).rejects.toThrow();
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED && e.some(c => String(c).includes('reason=intent_contract_id_mismatch')))).toHaveLength(1);
  });

  it('recovery skips publish when contract yaml id mismatches active path (Phase 1197 Step C)', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'yaml-mismatch-recover';
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);

    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(
      path.join(activeDir, CREATION_CLAIM_FILE),
      JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        started_at: '2026-07-12T10:00:00.000Z',
        contract: makeContractYaml({
          id: 'wrong-yaml-id',
          title: 'Mismatch',
          goal: 'Mismatch',
          subtasks: [{ id: 't1', description: 'T1' }],
          verification: [],
        }),
      }, null, 2),
    );

    await manager.init();

    expect(await manager.getProgress(contractId)).toBeNull();
    await expect(fs.access(path.join(activeDir, CREATION_CLAIM_FILE))).resolves.not.toThrow();
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED && e.some(c => String(c).includes('reason=contract_yaml_id_mismatch')))).toHaveLength(1);
  });

  it('recovery skips publish on legacy flat archive collision (Phase 1197 Step C)', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'legacy-flat-collision-recover';
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    const collisionDir = path.join(clawDir, 'contract', 'archive', contractId);

    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(
      path.join(activeDir, CREATION_CLAIM_FILE),
      JSON.stringify({
        schema_version: 1,
        contract_id: contractId,
        started_at: '2026-07-12T10:00:00.000Z',
        contract: makeContractYaml({
          id: contractId,
          title: 'Legacy',
          goal: 'Legacy',
          subtasks: [{ id: 't1', description: 'T1' }],
          verification: [],
        }),
      }, null, 2),
    );
    await fs.mkdir(collisionDir, { recursive: true });
    await fs.writeFile(path.join(collisionDir, 'contract.yaml'), 'schema_version: 1\nid: legacy-flat-collision-recover\ntitle: Legacy\ngoal: Legacy\nsubtasks:\n  - id: t1\n    description: D\n');

    await manager.init();

    await expect(fs.access(path.join(activeDir, CREATION_CLAIM_FILE))).resolves.not.toThrow();
    await expect(fs.access(path.join(activeDir, 'contract.yaml'))).rejects.toThrow();
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERED)).toBe(false);
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED && e.some(c => String(c).includes('reason=archive_collision')))).toHaveLength(1);
  });

  it('recovery leaves partial payload bytes untouched on archive collision (Phase 1197 Step C)', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'partial-payload-collision';
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    const collisionDir = path.join(clawDir, 'contract', 'archive', 'completed', contractId);

    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, CREATION_CLAIM_FILE), JSON.stringify({ schema_version: 1, contract_id: contractId, started_at: '2026-07-12T10:00:00.000Z', contract: makeContractYaml({ id: contractId, title: 'Partial', goal: 'Partial', subtasks: [{ id: 't1', description: 'T1' }], verification: [] }) }, null, 2));
    const partialYaml = 'schema_version: 1\nid: partial-payload-collision\ntitle: Original\ngoal: Original\nsubtasks:\n  - id: t1\n    description: Original\n';
    const partialProgress = JSON.stringify({ schema_version: 1, subtasks: { t1: { status: 'in_progress' } }, started_at: '2026-07-12T09:00:00.000Z', checkpoint: null }, null, 2);
    await fs.writeFile(path.join(activeDir, 'contract.yaml'), partialYaml);
    await fs.writeFile(path.join(activeDir, 'progress.json'), partialProgress);
    await fs.mkdir(collisionDir, { recursive: true });
    await fs.writeFile(path.join(collisionDir, 'contract.yaml'), 'schema_version: 1\nid: partial-payload-collision\ntitle: Archive\ngoal: Archive\nsubtasks:\n  - id: t1\n    description: D\n');

    await manager.init();

    expect(await fs.readFile(path.join(activeDir, 'contract.yaml'), 'utf-8')).toBe(partialYaml);
    expect(await fs.readFile(path.join(activeDir, 'progress.json'), 'utf-8')).toBe(partialProgress);
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERED)).toBe(false);
  });

  it('recovery leaves partial payload bytes untouched on intent ID mismatch (Phase 1197 Step C)', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'partial-payload-intent-mismatch';
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);

    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, CREATION_CLAIM_FILE), JSON.stringify({ schema_version: 1, contract_id: 'wrong-intent-id', started_at: '2026-07-12T10:00:00.000Z', contract: makeContractYaml({ id: contractId, title: 'Partial', goal: 'Partial', subtasks: [{ id: 't1', description: 'T1' }], verification: [] }) }, null, 2));
    const partialYaml = 'schema_version: 1\nid: partial-payload-intent-mismatch\ntitle: Original\ngoal: Original\nsubtasks:\n  - id: t1\n    description: Original\n';
    const partialProgress = JSON.stringify({ schema_version: 1, subtasks: { t1: { status: 'in_progress' } }, started_at: '2026-07-12T09:00:00.000Z', checkpoint: null }, null, 2);
    await fs.writeFile(path.join(activeDir, 'contract.yaml'), partialYaml);
    await fs.writeFile(path.join(activeDir, 'progress.json'), partialProgress);

    await manager.init();

    expect(await fs.readFile(path.join(activeDir, 'contract.yaml'), 'utf-8')).toBe(partialYaml);
    expect(await fs.readFile(path.join(activeDir, 'progress.json'), 'utf-8')).toBe(partialProgress);
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED && e.some(c => String(c).includes('reason=intent_contract_id_mismatch')))).toHaveLength(1);
  });

  it('recovery leaves partial payload bytes untouched on YAML ID mismatch (Phase 1197 Step C)', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'partial-payload-yaml-mismatch';
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);

    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, CREATION_CLAIM_FILE), JSON.stringify({ schema_version: 1, contract_id: contractId, started_at: '2026-07-12T10:00:00.000Z', contract: makeContractYaml({ id: 'wrong-yaml-id', title: 'Partial', goal: 'Partial', subtasks: [{ id: 't1', description: 'T1' }], verification: [] }) }, null, 2));
    const partialYaml = 'schema_version: 1\nid: partial-payload-yaml-mismatch\ntitle: Original\ngoal: Original\nsubtasks:\n  - id: t1\n    description: Original\n';
    const partialProgress = JSON.stringify({ schema_version: 1, subtasks: { t1: { status: 'in_progress' } }, started_at: '2026-07-12T09:00:00.000Z', checkpoint: null }, null, 2);
    await fs.writeFile(path.join(activeDir, 'contract.yaml'), partialYaml);
    await fs.writeFile(path.join(activeDir, 'progress.json'), partialProgress);

    await manager.init();

    expect(await fs.readFile(path.join(activeDir, 'contract.yaml'), 'utf-8')).toBe(partialYaml);
    expect(await fs.readFile(path.join(activeDir, 'progress.json'), 'utf-8')).toBe(partialProgress);
    expect(events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED && e.some(c => String(c).includes('reason=contract_yaml_id_mismatch')))).toHaveLength(1);
  });

  it('two consecutive init() produce identical refusal for archive collision (Phase 1197 Step C)', async () => {
    const { audit, events } = makeAudit();
    const manager = makeManager(audit);
    const contractId = 'idempotent-collision-refusal';
    const activeDir = path.join(clawDir, 'contract', 'active', contractId);
    const collisionDir = path.join(clawDir, 'contract', 'archive', 'corrupted', contractId);

    await fs.mkdir(activeDir, { recursive: true });
    await fs.writeFile(path.join(activeDir, CREATION_CLAIM_FILE), JSON.stringify({ schema_version: 1, contract_id: contractId, started_at: '2026-07-12T10:00:00.000Z', contract: makeContractYaml({ id: contractId, title: 'Refuse', goal: 'Refuse', subtasks: [{ id: 't1', description: 'T1' }], verification: [] }) }, null, 2));
    await fs.mkdir(collisionDir, { recursive: true });
    await fs.writeFile(path.join(collisionDir, 'contract.yaml'), 'schema_version: 1\nid: idempotent-collision-refusal\ntitle: Archive\ngoal: Archive\nsubtasks:\n  - id: t1\n    description: D\n');

    await manager.init();
    const markerAfterFirst = await fs.readFile(path.join(activeDir, CREATION_CLAIM_FILE), 'utf-8');
    const failedAfterFirst = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED && e.some(c => String(c).includes('reason=archive_collision'))).length;

    await manager.init();
    const markerAfterSecond = await fs.readFile(path.join(activeDir, CREATION_CLAIM_FILE), 'utf-8');
    const failedAfterSecond = events.filter(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERY_FAILED && e.some(c => String(c).includes('reason=archive_collision'))).length;

    expect(markerAfterSecond).toBe(markerAfterFirst);
    expect(failedAfterSecond).toBe(failedAfterFirst + 1);
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CONTRACT_CREATION_RECOVERED)).toBe(false);
    expect(events.some(e => e[0] === CONTRACT_AUDIT_EVENTS.CREATED)).toBe(false);
  });
});
