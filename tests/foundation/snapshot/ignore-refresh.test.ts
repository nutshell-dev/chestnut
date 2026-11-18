import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Snapshot } from '../../../src/foundation/snapshot/index.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../../src/foundation/snapshot/audit-events.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

describe('Snapshot existing-repository ignore refresh (phase 2196)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTrackedTempDir('snapshot-ignore-refresh-');
  });

  afterEach(async () => {
    await cleanupTempDir(dir);
  });

  async function createExistingRepository(): Promise<void> {
    await new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), makeMockAudit(), []).init();
  }

  it('preserves custom rules, untracks ignored files without deleting bytes, and is idempotent', async () => {
    await createExistingRepository();
    await writeFile(path.join(dir, 'viewport.tsv'), 'viewport-event\n');
    await writeFile(path.join(dir, '.gitignore'), '# local rule\nlocal.tmp\nlogs/\n*.tmp\n');
    git(dir, 'add', '.gitignore', 'viewport.tsv');
    git(dir, 'commit', '-m', 'track legacy viewport');

    const snapshot = new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), makeMockAudit(), ['viewport.tsv']);
    expect((await snapshot.init()).ok).toBe(true);

    expect(await readFile(path.join(dir, 'viewport.tsv'), 'utf8')).toBe('viewport-event\n');
    expect(git(dir, 'ls-files', 'viewport.tsv')).toBe('');
    expect(() => git(dir, 'check-ignore', 'viewport.tsv')).not.toThrow();
    const first = await readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(first).toContain('# local rule\nlocal.tmp\n');
    expect(first.match(/^viewport\.tsv$/gm)).toHaveLength(1);

    await snapshot.init();
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toBe(first);
  });

  it('serializes concurrent refreshes and appends a missing rule exactly once', async () => {
    await createExistingRepository();
    const snapshot = new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), makeMockAudit(), ['viewport.tsv']);

    const results = await Promise.all([snapshot.refreshIgnorePatterns(), snapshot.refreshIgnorePatterns()]);

    expect(results.every(result => result.ok)).toBe(true);
    const content = await readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(content.match(/^viewport\.tsv$/gm)).toHaveLength(1);
  });

  it('skips migration without consuming pre-existing staged business changes', async () => {
    await createExistingRepository();
    await writeFile(path.join(dir, 'business.txt'), 'keep staged\n');
    git(dir, 'add', 'business.txt');
    const audit = makeMockAudit();
    const snapshot = new Snapshot(dir, new NodeFileSystem({ baseDir: dir }), audit, ['viewport.tsv']);

    const result = await snapshot.refreshIgnorePatterns();

    expect(result).toMatchObject({ ok: true, value: { kind: 'skipped', reason: 'staged_changes' } });
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('business.txt');
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).not.toContain('viewport.tsv');
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.IGNORE_REFRESH_SKIPPED,
      expect.stringContaining('dir='),
      'reason=staged_changes',
      expect.stringContaining('business.txt'),
    );
  });

  it('keeps the existing repository and emits failure evidence when ignore writing fails', async () => {
    await createExistingRepository();
    const baseFs = new NodeFileSystem({ baseDir: dir });
    const failingFs = Object.create(baseFs) as NodeFileSystem;
    failingFs.writeAtomic = async () => { throw new Error('mock ignore write failure'); };
    const audit = makeMockAudit();
    const snapshot = new Snapshot(dir, failingFs, audit, ['viewport.tsv']);

    await expect(snapshot.init()).rejects.toThrow('mock ignore write failure');

    expect(git(dir, 'rev-parse', 'HEAD')).not.toBe('');
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.IGNORE_REFRESH_FAILED,
      expect.stringContaining('dir='),
      'stage=write_ignore',
      expect.stringContaining('mock ignore write failure'),
    );
  });
});
