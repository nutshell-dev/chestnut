/**
 * Phase 1267 D.2: SkillDuplicateError fail-loud reverse test
 *
 * loadAll() must escalate SkillDuplicateError instead of swallowing it.
 */
import { describe, it, expect, vi } from 'vitest';
import { SkillSystem, SkillDuplicateError, SkillParseError } from '../../../src/foundation/skill-system/registry.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { SKILL_AUDIT_EVENTS } from '../../../src/foundation/skill-system/audit-events.js';

function mockFs(files: Record<string, string>, dirs: string[]): FileSystem {
  return {
    exists: vi.fn(async (p: string) => p in files || dirs.includes(p)),
    read: vi.fn(async (p: string) => {
      if (!(p in files)) throw new Error(`mock: ${p} not found`);
      return files[p];
    }),
    list: vi.fn(async (p: string, _opts?: object) => {
      const children = dirs
        .filter(d => d.startsWith(p + '/') && d !== p)
        .map(d => d.slice(p.length + 1))
        .filter(n => !n.includes('/'));
      return children.map(name => ({
        name,
        path: `${p}/${name}`,
        isDirectory: true,
        isFile: false,
        size: 0,
        mtime: new Date(),
      })) as FileEntry[];
    }),
    writeAtomic: vi.fn(),
    append: vi.fn(),
    delete: vi.fn(),
    move: vi.fn(),
    ensureDir: vi.fn(),
    removeDir: vi.fn(),
    isDirectory: vi.fn(async (p: string) => dirs.includes(p)),
    stat: vi.fn(),
    writeAtomicSync: vi.fn(),
    writeExclusiveSync: vi.fn(),
    readSync: vi.fn(),
    readBytesSync: vi.fn(),
    appendSync: vi.fn(),
    statSync: vi.fn(),
    moveSync: vi.fn(),
    existsSync: vi.fn(),
    ensureDirSync: vi.fn(),
    listSync: vi.fn(),
    deleteSync: vi.fn(),
    resolve: vi.fn((p: string) => p),
  } as unknown as FileSystem;
}

function mockAudit(): AuditLog & { calls: Array<[string, ...string[]]> } {
  const calls: Array<[string, ...string[]]> = [];
  return {
    write: vi.fn((type: string, ...args: string[]) => {
      calls.push([type, ...args]);
    }),
    calls,
  } as unknown as AuditLog & { calls: Array<[string, ...string[]]> };
}

describe('phase 1267 D.2: SkillDuplicateError fail-loud in loadAll', () => {
  it('reverse 1: duplicate skill in loadAll → throws SkillDuplicateError (escalated, not swallowed)', async () => {
    const skillsDir = '/skills';
    const dir1 = '/skills/foo';
    const dir2 = '/skills/bar';
    const fs = mockFs(
      {
        [`${dir1}/SKILL.md`]: '---\nname: dup\n---\n',
        [`${dir2}/SKILL.md`]: '---\nname: dup\n---\n',
      },
      [skillsDir, dir1, dir2],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    await expect(sys.loadAll()).rejects.toThrow(SkillDuplicateError);
  });

  it('reverse 2: SkillParseError in loadAll (e.g. frontmatter parse fail) → swallowed + LOAD_FAILED audit + continue', async () => {
    const skillsDir = '/skills';
    const dir1 = '/skills/bad';
    const dir2 = '/skills/good';
    const fs = mockFs(
      {
        [`${dir1}/SKILL.md`]: '---\nname: ok\n---\n', // valid frontmatter, but let's simulate a parse failure by overriding behavior
        [`${dir2}/SKILL.md`]: '---\nname: good-skill\n---\n',
      },
      [skillsDir, dir1, dir2],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    // Make loadSkillMeta throw SkillParseError for dir1
    const originalLoadSkillMeta = (sys as any).loadSkillMeta.bind(sys);
    (sys as any).loadSkillMeta = vi.fn(async (skillDir: string) => {
      if (skillDir === dir1) {
        throw new SkillParseError(skillDir, 'mock frontmatter parse failure');
      }
      return originalLoadSkillMeta(skillDir);
    });

    await sys.loadAll();
    (sys as any)._loaded = true; // prevent _ensureLoaded from re-running loadAll

    const loadFailedCall = audit.calls.find(
      c => c[0] === SKILL_AUDIT_EVENTS.LOAD_FAILED,
    );
    expect(loadFailedCall).toBeDefined();
    expect(loadFailedCall!.slice(1).join(' ')).toContain('mock frontmatter parse failure');

    // good skill should still be loaded
    expect(sys.getMeta('good-skill')).toBeDefined();
  });

  it('reverse 4: unknown I/O error in loadAll (e.g. EACCES) → RESCAN_ABORTED audit + preserve old Map', async () => {
    const skillsDir = '/skills';
    const dirGood = '/skills/good';
    const dirBad = '/skills/bad';
    const files: Record<string, string> = {
      [`${dirGood}/SKILL.md`]: '---\nname: good-skill\n---\n',
      [`${dirBad}/SKILL.md`]: '---\nname: bad-skill\n---\n',
    };
    const dirs = [skillsDir, dirGood];
    const fs = mockFs(files, dirs);
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    // Seed old Map with only good-skill
    await sys.loadAll();
    (sys as any)._loaded = true;
    expect(sys.getMeta('good-skill')).toBeDefined();
    expect(sys.getMeta('bad-skill')).toBeUndefined();

    // Second rescan: bad-skill appears and its read throws EACCES
    dirs.push(dirBad);
    const originalRead = (fs as any).read.getMockImplementation();
    (fs as any).read = vi.fn(async (p: string) => {
      if (p === `${dirBad}/SKILL.md`) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return originalRead!(p);
    });

    await sys.loadAll();

    const rescanAbortedCall = audit.calls.find(
      c => c[0] === SKILL_AUDIT_EVENTS.RESCAN_ABORTED,
    );
    expect(rescanAbortedCall).toBeDefined();
    expect(rescanAbortedCall!.slice(1).join(' ')).toContain('EACCES');

    // old Map preserved: good-skill still present, bad-skill never committed
    expect(sys.getMeta('good-skill')).toBeDefined();
    expect(sys.getMeta('bad-skill')).toBeUndefined();
  });

  it('reverse 3: single duplicate skill → loadAll rejects with SkillDuplicateError carrying correct metadata', async () => {
    const skillsDir = '/skills';
    const dir1 = '/skills/first';
    const dir2 = '/skills/second';
    const fs = mockFs(
      {
        [`${dir1}/SKILL.md`]: '---\nname: collide\n---\n',
        [`${dir2}/SKILL.md`]: '---\nname: collide\n---\n',
      },
      [skillsDir, dir1, dir2],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    let caught: Error | undefined;
    try {
      await sys.loadAll();
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(SkillDuplicateError);
    const dup = caught as SkillDuplicateError;
    expect(dup.skillName).toBe('collide');
    expect(dup.existingDir).toBe(dir1);
    expect(dup.attemptedDir).toBe(dir2);
  });

  // phase 1128 P1-8: fire-and-forget _ensureLoaded() rejection must be observed
  it('sync accessor with failing loadAll (duplicate skill) → no unhandled rejection, error observable via audit + console', async () => {
    const skillsDir = '/skills';
    const dir1 = '/skills/first';
    const dir2 = '/skills/second';
    const fs = mockFs(
      {
        [`${dir1}/SKILL.md`]: '---\nname: collide\n---\n',
        [`${dir2}/SKILL.md`]: '---\nname: collide\n---\n',
      },
      [skillsDir, dir1, dir2],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    const unhandledSpy = vi.fn();
    process.on('unhandledRejection', unhandledSpy);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Intentionally not awaiting ensureLoaded: mimic cold-start sync accessor usage.
      sys.listMeta();
      // 等 fire-and-forget 后台加载 rejection 落地（异步边界、无事件可等）
      const BACKGROUND_REJECTION_SETTLE_MS = 10;
      await new Promise((r) => setTimeout(r, BACKGROUND_REJECTION_SETTLE_MS));

      expect(unhandledSpy).not.toHaveBeenCalled();

      // console.error should receive the background load failure message (and possibly
      // the maybeWarnUnloaded warning). Filter to the background-load message.
      const bgLoadErrorCall = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('background load failed'),
      );
      expect(bgLoadErrorCall).toBeDefined();
      expect(String(bgLoadErrorCall![0])).toContain('Skill duplicate registration rejected');

      const loadFailedCall = audit.calls.find(
        c => c[0] === SKILL_AUDIT_EVENTS.LOAD_FAILED,
      );
      expect(loadFailedCall).toBeDefined();
      expect(loadFailedCall!.slice(1).join(' ')).toContain('context=background_ensure_loaded');

      // _loaded must remain false so the next accessor call can retry.
      expect((sys as any)._loaded).toBe(false);
    } finally {
      process.off('unhandledRejection', unhandledSpy);
      consoleSpy.mockRestore();
    }
  });
});
