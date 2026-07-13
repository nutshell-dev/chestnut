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
      // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
      os.tmpdir(),
      `.test-evolution-boot-reconcile-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
    );
    clawDir = path.join(testDir, 'motion');
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(clawDir, { recursive: true });
    auditWrite = vi.fn();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    vi.restoreAllMocks();
  });

  function makeSystem() {
    const nodeFs = new NodeFileSystem({ baseDir: clawDir });
    return new EvolutionSystem({
      fs: nodeFs,
      audit: { write: auditWrite , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any,
      taskSystem: {} as any,
      contractManager: {} as any,
    });
  }

  it('emits EVOLUTION_BOOT_RECONCILE + loads lastProcessedAt when state file exists', async () => {
    await fs.writeFile(
      path.join(clawDir, '.evolution-system-state.json'),
      JSON.stringify({
        version: 1,
        lastProcessedAt: 1717000000000,
      }),
    );

    const sys = makeSystem();
    await sys.init();

    const reconcileCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall).toContainEqual('last_processed_at=1717000000000');
    expect(reconcileCall).toContainEqual('high_water_mark_mode=true');
  });

  it('emits EVOLUTION_BOOT_RECONCILE high_water_mark_mode when no state file', async () => {
    const sys = makeSystem();
    await sys.init();

    const reconcileCall = auditWrite.mock.calls.find(
      (c: any) => c[0] === RETRO_AUDIT_EVENTS.EVOLUTION_BOOT_RECONCILE,
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall).toContainEqual('last_processed_at=0');
    expect(reconcileCall).toContainEqual('high_water_mark_mode=true');
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
    expect(reconcileCall).toContainEqual('last_processed_at=0');
  });
});
