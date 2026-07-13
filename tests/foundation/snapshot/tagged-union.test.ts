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

let gitAvailable = false;
try { execSync('which git', { stdio: 'ignore' }); gitAvailable = true; } catch { /* git not found */ }

describe.skipIf(!gitAvailable)('snapshot SnapshotState tagged union (phase 285 Step A)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snap-tagged-union-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists tagged-union shape after commit failures', async () => {
    const audit = makeMockAudit();
    const fs = new NodeFileSystem({ baseDir: tmpDir });

    const snapshot = new Snapshot(tmpDir, fs, audit, []);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot.commit('fail-1');

    const persistPath = path.join(tmpDir, '.git', '.snapshot-state.json');
    expect(fsSync.existsSync(persistPath)).toBe(true);

    const raw = await fsp.readFile(persistPath, 'utf-8');
    const state = JSON.parse(raw);
    expect(state).toEqual({
      kind: 'degraded',
      failures: 1,
      degradedAt: expect.any(Number),
    });
  });

  it('resets to ok branch after successful commit', async () => {
    const audit = makeMockAudit();
    const fs = new NodeFileSystem({ baseDir: tmpDir });

    const snapshot = new Snapshot(tmpDir, fs, audit, []);
    await snapshot.init();
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot.commit('fail-1');
    expect(fsSync.existsSync(path.join(tmpDir, '.git', '.snapshot-state.json'))).toBe(true);

    // restore HEAD so next commit succeeds and clears persist
    await fsp.writeFile(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    await snapshot.commit('success');
    expect(fsSync.existsSync(path.join(tmpDir, '.git', '.snapshot-state.json'))).toBe(false);
  });

  it('migrates legacy schema on load and emits audit', async () => {
    const audit = makeMockAudit();
    const fs = new NodeFileSystem({ baseDir: tmpDir });

    // pre-seed a git repo + legacy persist file
    const snapshot0 = new Snapshot(tmpDir, fs, audit, []);
    await snapshot0.init();

    const persistPath = path.join(tmpDir, '.git', '.snapshot-state.json');
    await fsp.writeFile(persistPath, JSON.stringify({ consecutiveFailures: 2, degradedAt: 4242 }));

    const audit2 = makeMockAudit();
    const snapshot1 = new Snapshot(tmpDir, fs, audit2, []);
    await snapshot1.init();

    expect(audit2.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED,
      'failures=2',
      'degradedAt=4242',
    );

    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // only 1 more failure needed to trigger DEGRADED because legacy failures=2 was preserved
    await snapshot1.commit('fail-3');
    expect(audit2.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.DEGRADED,
      expect.stringContaining('dir='),
      expect.stringContaining('consecutive=3'),
    );
  });

  it('migrates legacy partial-failure state (no degradedAt) with fallback timestamp', async () => {
    const audit = makeMockAudit();
    const fs = new NodeFileSystem({ baseDir: tmpDir });

    const snapshot0 = new Snapshot(tmpDir, fs, audit, []);
    await snapshot0.init();

    const persistPath = path.join(tmpDir, '.git', '.snapshot-state.json');
    await fsp.writeFile(persistPath, JSON.stringify({ consecutiveFailures: 1 }));

    const before = Date.now();
    const audit2 = makeMockAudit();
    const snapshot1 = new Snapshot(tmpDir, fs, audit2, []);
    await snapshot1.init();

    expect(audit2.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.LEGACY_SCHEMA_MIGRATED,
      'failures=1',
    );

    // state_restored_from_disk audit should report preserved failure count
    expect(audit2.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.COMMIT_FAILED,
      expect.stringContaining('dir='),
      'context=state_restored_from_disk',
      'consecutive=1',
    );

    // trigger one commit failure to persist the migrated state
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await snapshot1.commit('fail-2');

    const after = Date.now();

    const raw = await fsp.readFile(persistPath, 'utf-8');
    const state = JSON.parse(raw);
    expect(state.kind).toBe('degraded');
    expect(state.failures).toBe(2);
    expect(state.degradedAt).toBeGreaterThanOrEqual(before);
    expect(state.degradedAt).toBeLessThanOrEqual(after);
  });

  it('DEGRADED still fires only on the 3rd consecutive failure', async () => {
    const audit = makeMockAudit();
    const fs = new NodeFileSystem({ baseDir: tmpDir });

    const snapshot = new Snapshot(tmpDir, fs, audit, []);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot.commit('fail-1');
    expect(audit.write).not.toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.DEGRADED,
      expect.anything(),
      expect.anything(),
    );

    await snapshot.commit('fail-2');
    expect(audit.write).not.toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.DEGRADED,
      expect.anything(),
      expect.anything(),
    );

    await snapshot.commit('fail-3');
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.DEGRADED,
      expect.stringContaining('dir='),
      expect.stringContaining('consecutive=3'),
    );
  });
});
