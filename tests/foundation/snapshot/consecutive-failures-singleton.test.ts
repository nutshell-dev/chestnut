/**
 * Reverse tests for consecutiveFailures module-level singleton + persist
 *
 * Case 1: cross-reassemble accumulation (same dir, new instance)
 * Case 2: DEGRADED trigger + persist file verify
 * Case 3: persist file load on init
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { Snapshot } from '../../../src/foundation/snapshot/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
import { makeMockAudit } from '../../helpers/audit.js';

// git 必须可用才能跑这些测试
let gitAvailable = false;
try { execSync('which git', { stdio: 'ignore' }); gitAvailable = true; } catch { /* git not found */ }

describe.skipIf(!gitAvailable)('consecutiveFailures singleton', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snap-singleton-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('Case 2: DEGRADED trigger writes persist file with degradedAt', async () => {
    const audit = makeMockAudit();
    const fs = new NodeFileSystem({ baseDir: tmpDir });

    const snapshot = new Snapshot(tmpDir, fs, audit, []);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot.commit('fail-1');
    await snapshot.commit('fail-2');
    await snapshot.commit('fail-3');

    const persistPath = path.join(tmpDir, '.git', '.snapshot-state.json');
    expect(fsSync.existsSync(persistPath)).toBe(true);

    const raw = await fsp.readFile(persistPath, 'utf-8');
    const state = JSON.parse(raw);
    expect(state.kind).toBe('degraded');
    expect(state.failures).toBe(3);
    expect(typeof state.degradedAt).toBe('number');
    expect(state.degradedAt).toBeGreaterThan(0);
  });

  it('Case 3: persist file loaded on init, leading to faster DEGRADED', async () => {
    const audit = makeMockAudit();
    const fs = new NodeFileSystem({ baseDir: tmpDir });

    // pre-seed a git repo + persist file with 2 prior failures
    const snapshot0 = new Snapshot(tmpDir, fs, audit, []);
    await snapshot0.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));
    await snapshot0.commit('fail-1');
    await snapshot0.commit('fail-2');

    // persist file should exist now
    const persistPath = path.join(tmpDir, '.git', '.snapshot-state.json');
    expect(fsSync.existsSync(persistPath)).toBe(true);

    // simulate process restart: NEW instance, init loads persist
    const audit2 = makeMockAudit();
    const snapshot1 = new Snapshot(tmpDir, fs, audit2, []);
    await snapshot1.init();

    // init re-initializes incomplete repo (HEAD was deleted above);
    // re-delete HEAD so commit fails as intended for this test
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    // only 1 more failure needed to trigger DEGRADED
    await snapshot1.commit('fail-3');

    expect(audit2.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.DEGRADED,
      expect.stringContaining('dir='),
      expect.stringContaining('consecutive=3'),
    );
  });
});
