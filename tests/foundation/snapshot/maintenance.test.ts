import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Snapshot } from '../../../src/foundation/snapshot/index.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { exec } from '../../../src/foundation/process-exec/index.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

/** Short deterministic overlap window; only proves operations never run concurrently. */
const GC_COMPLETION_DELAY_MS = 25;

function head(dir: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('Snapshot maintenance (phase 2196)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTrackedTempDir('snapshot-maintenance-');
  });

  afterEach(async () => {
    await cleanupTempDir(dir);
  });

  it('packs objects with --no-prune, preserves history, and returns repository/disk facts', async () => {
    const audit = makeMockAudit();
    const snapshot = new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), audit, []);
    await snapshot.init();
    const beforeHead = head(dir);

    const result = await snapshot.maintain();

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.after.packCount).toBeGreaterThan(0);
      expect(result.after.gitBytes).toBeGreaterThan(0);
      expect(result.after.diskAvailableBytes).toBeGreaterThan(0);
      expect(result.after.packBytes).toBeGreaterThan(0);
    }
    expect(head(dir)).toBe(beforeHead);
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.MAINTENANCE_COMPLETED,
      expect.stringContaining('dir='),
      expect.stringContaining('before_git_bytes='),
      expect.stringContaining('after_git_bytes='),
      expect.stringContaining('loose_objects='),
      expect.stringContaining('pack_bytes='),
      expect.stringContaining('disk_available_bytes='),
      'warnings=0',
    );
  });

  it('emits actionable threshold warnings with actual values', async () => {
    const audit = makeMockAudit();
    const snapshot = new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), audit, []);
    await snapshot.init();

    const result = await snapshot.maintain({
      thresholds: {
        gitWarnBytes: 1,
        looseObjectWarnCount: 1,
        diskAvailableWarnBytes: Number.MAX_SAFE_INTEGER,
      },
    });

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.warnings.map(warning => warning.kind)).toEqual([
        'git_size',
        'loose_objects',
        'disk_available',
      ]);
    }
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SPACE_WARNING,
      expect.stringContaining('dir='),
      'kind=disk_available',
      expect.stringContaining('actual='),
      `threshold=${Number.MAX_SAFE_INTEGER}`,
    );
  });

  it('returns a typed timeout and preserves the original failure evidence', async () => {
    const audit = makeMockAudit();
    const failingExec: typeof exec = async (command, args, options) => {
      if (args[0] === 'gc') {
        throw Object.assign(new Error('mock gc timeout'), {
          termination: { trigger: 'timeout' },
        });
      }
      return exec(command, args, options);
    };
    const snapshot = new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), audit, [], undefined, failingExec);
    await snapshot.init();

    const result = await snapshot.maintain();

    expect(result).toMatchObject({ kind: 'failed', reason: 'timeout', error: expect.stringContaining('mock gc timeout') });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.MAINTENANCE_FAILED,
      expect.stringContaining('dir='),
      'kind=timeout',
      expect.stringContaining('mock gc timeout'),
    );
  });

  it('does not start gc when already cancelled', async () => {
    const audit = makeMockAudit();
    const snapshot = new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), audit, []);
    await snapshot.init();
    const controller = new AbortController();
    controller.abort();

    await expect(snapshot.maintain({ signal: controller.signal })).resolves.toEqual({
      kind: 'skipped',
      reason: 'cancelled',
    });
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.MAINTENANCE_SKIPPED,
      expect.stringContaining('dir='),
      'reason=cancelled',
    );
  });

  it('serializes maintenance and commit git operations', async () => {
    const audit = makeMockAudit();
    await new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), makeMockAudit(), []).init();
    let active = 0;
    let maxActive = 0;
    const trackedExec: typeof exec = async (command, args, options) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (args[0] === 'gc') await new Promise(resolve => setTimeout(resolve, GC_COMPLETION_DELAY_MS));
        return await exec(command, args, options);
      } finally {
        active--;
      }
    };
    const snapshot = new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), audit, [], undefined, trackedExec);
    await writeFile(path.join(dir, 'data.txt'), 'commit during maintenance\n');

    const [maintenance, commit] = await Promise.all([
      snapshot.maintain(),
      snapshot.commit('serialized commit'),
    ]);

    expect(maintenance.kind).toBe('completed');
    expect(commit.ok).toBe(true);
    expect(maxActive).toBe(1);
  });
});
