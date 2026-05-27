/**
 * @module tests/core/evolution-system/boot-reconcile
 * Phase 1335 sub-2: EvolutionSystem.init() eager boot reconcile reverse test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EvolutionSystem } from '../../../src/core/evolution-system/system.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { RETRO_AUDIT_EVENTS } from '../../../src/core/evolution-system/retro-audit-events.js';

describe('EvolutionSystem.init() boot reconcile', () => {
  let testDir: string;
  let clawDir: string;
  let auditWrite: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `.test-evolution-boot-reconcile-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'motion');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(clawDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  function makeSystem() {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    return new EvolutionSystem({
      fs: nodeFs,
      audit: { write: auditWrite } as any,
      taskSystem: {} as any,
      contractManager: {} as any,
    });
  }

  it('emits EVOLUTION_BOOT_RECONCILE + loads processedContractIds when state file exists', async () => {
    await fs.writeFile(
      path.join(clawDir, '.evolution-system-state.json'),
      JSON.stringify({
        version: 1,
        processedContractIds: ['c1', 'c2'],
        lastProcessedAt: new Date().toISOString(),
      }),
    );

    const sys = makeSystem();
    await sys.init();

    const reconcileCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall).toContainEqual('processed_count=2');
    expect(reconcileCall).toContainEqual('recovered=true');
  });

  it('emits EVOLUTION_BOOT_RECONCILE recovered=false when no state file', async () => {
    const sys = makeSystem();
    await sys.init();

    const reconcileCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall).toContainEqual('processed_count=0');
    expect(reconcileCall).toContainEqual('recovered=false');
  });

  it('corrupt state file triggers backup path + audit emit', async () => {
    await fs.writeFile(
      path.join(clawDir, '.evolution-system-state.json'),
      'not-json',
    );

    const sys = makeSystem();
    await sys.init();

    const loadFailedCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.STATE_LOAD_FAILED,
    );
    expect(loadFailedCall).toBeDefined();

    const reconcileCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall).toContainEqual('processed_count=0');
  });
});
