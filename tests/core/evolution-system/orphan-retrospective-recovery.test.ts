import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { EvolutionSystem, type MotionReviewContext } from '../../../src/core/evolution-system/system.js';
import {
  DISPATCHING_DIR,
  ORPHAN_OUTCOMES_DIR,
  RETIRED_DIR,
  RetrospectiveStore,
} from '../../../src/core/evolution-system/retrospective-store.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';
import { makeContractId, type ContractId } from '../../../src/core/contract/types.js';
import type { FullTaskId } from '../../../src/core/async-task-system/types.js';
import { prepareRetroInputForTest } from './execution-input-fixture.js';

function makeAudit(): { audit: AuditLog; events: Array<[string, ...(string | number)[]]> } {
  const events: Array<[string, ...(string | number)[]]> = [];
  return {
    events,
    audit: {
      write: (type: string, ...cols: (string | number)[]) => { events.push([type, ...cols]); },
      preview: (value: string) => value,
      message: (value: string) => value,
      summary: (value: string) => value,
    },
  };
}

interface Fixture {
  baseDir: string;
  motionFs: NodeFileSystem;
  clawDir: string;
  contractId: ContractId;
  audit: ReturnType<typeof makeAudit>;
  store: RetrospectiveStore;
  system: EvolutionSystem;
  schedulePrepared: ReturnType<typeof vi.fn>;
  manager: {
    getProgress: ReturnType<typeof vi.fn>;
    readContractYamlRaw: ReturnType<typeof vi.fn>;
  };
  managerFactory: ReturnType<typeof vi.fn>;
  ctx: MotionReviewContext;
}

describe('EvolutionSystem archived orphan recovery (Phase 2185)', () => {
  let fixture: Fixture | undefined;

  beforeEach(async () => {
    const baseDir = await createTempDir('retro-orphan-recovery-');
    mkdirSync(baseDir, { recursive: true });
    const motionFs = new NodeFileSystem({ baseDir: path.join(baseDir, 'motion') });
    const clawDir = path.join(baseDir, 'claws', 'claw-a');
    const contractId = makeContractId('onboarding');
    const audit = makeAudit();
    const store = new RetrospectiveStore({ fs: motionFs, audit: audit.audit });
    await store.ensure({ contractId, targetExecutorId: 'claw-a' });
    expect(await store.beginDispatch(contractId)).toBe('acquired');

    const manager = {
      getProgress: vi.fn().mockResolvedValue({ completed_at: '2026-11-17T01:00:00.000Z' }),
      readContractYamlRaw: vi.fn().mockResolvedValue('contract_id: onboarding\nintent: replay'),
    };
    const managerFactory = vi.fn().mockResolvedValue(manager);
    const schedulePrepared = vi.fn().mockImplementation(async (_kind: string, prepared: { id: FullTaskId }) => ({
      taskId: prepared.id,
      disposition: 'created',
    }));
    const ctx: MotionReviewContext = {
      motionFs,
      motionBaseDir: path.join(baseDir, 'motion'),
      motionAudit: audit.audit,
      clawsBaseDir: path.join(baseDir, 'claws'),
      clawFsFactory: () => new NodeFileSystem({ baseDir: clawDir }),
      clawContractManagerFactory: managerFactory,
    };
    const system = new EvolutionSystem({
      fs: motionFs,
      audit: audit.audit,
      taskSystem: { schedulePrepared } as any,
      prepareSubagentInput: prepareRetroInputForTest,
      contractManager: {} as any,
      motionReviewContext: ctx,
      skillVersions: { formatPublishedForContext: () => 'No skills loaded' } as any,
    });
    fixture = {
      baseDir,
      motionFs,
      clawDir,
      contractId,
      audit,
      store,
      system,
      schedulePrepared,
      manager,
      managerFactory,
      ctx,
    };
  });

  afterEach(async () => {
    if (fixture) await cleanupTempDir(fixture.baseDir);
    fixture = undefined;
  });

  it('retires the onboarding archived-completed orphan once and preserves replay evidence', async () => {
    const f = fixture!;
    const clawFs = new NodeFileSystem({ baseDir: f.clawDir });
    await clawFs.ensureDir('contract/archive/completed/onboarding');
    await clawFs.writeAtomic(
      'contract/archive/completed/onboarding/contract.yaml',
      'contract_id: onboarding\nintent: replay',
    );
    const originalBytes = await f.motionFs.read(`${DISPATCHING_DIR}/onboarding.json`);

    const first = await f.system.recoverRetrospectives(f.ctx);
    expect(first).toMatchObject({ failed: 0, recovered: 0, retired: 1 });
    expect(f.schedulePrepared).not.toHaveBeenCalled();
    expect(f.manager.readContractYamlRaw).not.toHaveBeenCalled();
    expect(await f.motionFs.exists(`${DISPATCHING_DIR}/onboarding.json`)).toBe(false);
    expect(await f.motionFs.read(`${RETIRED_DIR}/onboarding.json`)).toBe(originalBytes);

    const outcome = await f.store.readOrphanOutcome(f.contractId);
    expect(outcome).toMatchObject({
      contract_id: 'onboarding',
      contract_ref: 'contract/archive/completed/onboarding/contract.yaml',
      archive_path: 'contract/archive/completed/onboarding',
      completed_at: '2026-11-17T01:00:00.000Z',
      dispatching_bytes: originalBytes,
      cause: null,
    });
    expect(f.audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_ORPHAN_ARCHIVED)).toHaveLength(1);

    const second = await f.system.recoverRetrospectives(f.ctx);
    expect(second).toMatchObject({ failed: 0, recovered: 0, retired: 0 });
    expect(f.audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_ORPHAN_ARCHIVED)).toHaveLength(1);
    expect(f.audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.YAML_FAILED)).toEqual([]);
    expect(f.audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_RECOVERY_FAILED)).toEqual([]);
    expect(await f.motionFs.exists(`${ORPHAN_OUTCOMES_DIR}/onboarding.json`)).toBe(true);
  });

  it('concurrent boot reconciliation converges to one terminal outcome and audit', async () => {
    const f = fixture!;
    const clawFs = new NodeFileSystem({ baseDir: f.clawDir });
    await clawFs.ensureDir('contract/archive/completed/onboarding');
    const fresh = new EvolutionSystem({
      fs: f.motionFs,
      audit: f.audit.audit,
      taskSystem: { schedulePrepared: f.schedulePrepared } as any,
      prepareSubagentInput: prepareRetroInputForTest,
      contractManager: {} as any,
      motionReviewContext: f.ctx,
      skillVersions: { formatPublishedForContext: () => 'No skills loaded' } as any,
    });

    const results = await Promise.all([
      f.system.recoverRetrospectives(f.ctx),
      fresh.recoverRetrospectives(f.ctx),
    ]);
    expect(results.reduce((sum, result) => sum + result.retired, 0)).toBe(1);
    expect(results.every(result => result.failed === 0)).toBe(true);
    expect(f.schedulePrepared).not.toHaveBeenCalled();
    expect(f.audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_ORPHAN_ARCHIVED)).toHaveLength(1);
    expect(await f.motionFs.list(RETIRED_DIR, { includeDirs: false })).toHaveLength(1);
    expect(await f.motionFs.list(ORPHAN_OUTCOMES_DIR, { includeDirs: false })).toHaveLength(1);
  });

  it('resumes an active dispatching row through the existing submission path', async () => {
    const f = fixture!;
    const clawFs = new NodeFileSystem({ baseDir: f.clawDir });
    await clawFs.ensureDir('contract/active/onboarding');

    const result = await f.system.recoverRetrospectives(f.ctx);
    expect(result).toMatchObject({ failed: 0, recovered: 1, retired: 0 });
    expect(f.schedulePrepared).toHaveBeenCalledTimes(1);
    expect(await f.motionFs.exists(`${DISPATCHING_DIR}/onboarding.json`)).toBe(false);
    expect(f.audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_ORPHAN_UNRESOLVED)).toEqual([]);
  });

  it('keeps a missing contract dispatching with typed retry evidence', async () => {
    const f = fixture!;
    f.manager.getProgress.mockResolvedValue(null);

    const result = await f.system.recoverRetrospectives(f.ctx);
    expect(result).toMatchObject({ failed: 1, recovered: 0, retired: 0 });
    expect(f.schedulePrepared).not.toHaveBeenCalled();
    expect(await f.motionFs.exists(`${DISPATCHING_DIR}/onboarding.json`)).toBe(true);
    const events = f.audit.events.filter(e => e[0] === RETRO_AUDIT_EVENTS.RETRO_ORPHAN_UNRESOLVED);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.arrayContaining([
      'contractId=onboarding',
      'observation=missing',
      'cause=contract_not_found',
    ]));
    expect(events[0].some(col => typeof col === 'string' && col.startsWith('nextAttemptAtMs='))).toBe(true);
  });

  it('classifies corrupt lifecycle evidence without retiring or dispatching', async () => {
    const f = fixture!;
    const clawFs = new NodeFileSystem({ baseDir: f.clawDir });
    await clawFs.ensureDir('contract/active');
    await clawFs.writeAtomic('contract/active/onboarding', 'not a directory');

    const result = await f.system.recoverRetrospectives(f.ctx);
    expect(result).toMatchObject({ failed: 1, retired: 0 });
    expect(f.schedulePrepared).not.toHaveBeenCalled();
    expect(await f.motionFs.exists(`${DISPATCHING_DIR}/onboarding.json`)).toBe(true);
    expect(f.audit.events.some(e =>
      e[0] === RETRO_AUDIT_EVENTS.RETRO_ORPHAN_UNRESOLVED && e.includes('observation=corrupt'),
    )).toBe(true);
  });

  it('classifies terminal-fact I/O failure as retryable and preserves its cause', async () => {
    const f = fixture!;
    const ioError = Object.assign(new Error('injected EIO'), { code: 'EIO' });
    class IoFailureFs extends NodeFileSystem {
      override async stat(p: string) {
        if (p === 'contract/active/onboarding') throw ioError;
        return super.stat(p);
      }
    }
    f.ctx.clawFsFactory = () => new IoFailureFs({ baseDir: f.clawDir });

    const result = await f.system.recoverRetrospectives(f.ctx);
    expect(result).toMatchObject({ failed: 1, retired: 0 });
    expect(f.schedulePrepared).not.toHaveBeenCalled();
    expect(await f.motionFs.exists(`${DISPATCHING_DIR}/onboarding.json`)).toBe(true);
    const event = f.audit.events.find(e =>
      e[0] === RETRO_AUDIT_EVENTS.RETRO_ORPHAN_UNRESOLVED && e.includes('observation=io_failed'),
    );
    expect(event).toBeDefined();
    expect(event!.some(col => typeof col === 'string' && col.includes('injected EIO'))).toBe(true);
  });
});
