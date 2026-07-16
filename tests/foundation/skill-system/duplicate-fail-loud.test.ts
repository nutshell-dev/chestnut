/**
 * Phase 1267 D.2: SkillDuplicateError fail-loud reverse test
 *
 * loadAll() must escalate SkillDuplicateError instead of swallowing it.
 */
import { describe, it, expect, vi } from 'vitest';
import { SkillSystem, SkillDuplicateError } from '../../../src/foundation/skill-system/registry.js';
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

  it('reverse 2: non-duplicate error in loadAll (e.g. frontmatter parse fail) → swallowed + LOAD_FAILED audit + continue', async () => {
    const skillsDir = '/skills';
    const dir1 = '/skills/bad';
    const dir2 = '/skills/good';
    const fs = mockFs(
      {
        [`${dir1}/SKILL.md`]: '---\nname: ok\n---\n', // valid frontmatter, but let's simulate a namespace-invalid by overriding behavior
        [`${dir2}/SKILL.md`]: '---\nname: good-skill\n---\n',
      },
      [skillsDir, dir1, dir2],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    // Make loadSkillMeta throw a non-SkillDuplicateError for dir1
    const originalLoadSkillMeta = (sys as any).loadSkillMeta.bind(sys);
    (sys as any).loadSkillMeta = vi.fn(async (skillDir: string) => {
      if (skillDir === dir1) {
        throw new Error('mock frontmatter parse failure');
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
});
