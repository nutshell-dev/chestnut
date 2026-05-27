import { describe, it, expect, vi } from 'vitest';
import { SkillSystem, SkillDuplicateError } from '../../../src/foundation/skill-system/registry.js';
import type { FileSystem, FileEntry } from '../../../src/foundation/fs/types.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';

// Helper: build minimal FileSystem mock
function mockFs(files: Record<string, string>, dirs: string[]): FileSystem {
  return {
    exists: vi.fn(async (p: string) => p in files || dirs.includes(p)),
    read: vi.fn(async (p: string) => {
      if (!(p in files)) throw new Error(`mock: ${p} not found`);
      return files[p];
    }),
    list: vi.fn(async (p: string, _opts?: object) => {
      const children = dirs
        .filter(d => d.startsWith(p + '/'))
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

describe('skill-system registry edge cases (phase 953)', () => {
  it('B1: SKILL.md with EOF (no trailing newline) registers successfully', async () => {
    const skillsDir = '/skills';
    const skillDir = '/skills/foo';
    const skillMdPath = `${skillDir}/SKILL.md`;
    const fs = mockFs(
      {
        [skillMdPath]:
          '---\nname: foo\ndescription: bar\nversion: 1.0.0\n---' /* no trailing \n */,
      },
      [skillsDir, skillDir],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    await sys.loadAll();

    expect(sys.getMeta('foo')).toEqual({
      name: 'foo',
      description: 'bar',
      version: '1.0.0',
      skillDir,
    });
    // 0 LOAD_FAILED audit
    expect(
      audit.calls.find(
        c =>
          c[0] === 'skill_load_failed' || c[0].includes('LOAD_FAILED'),
      ),
    ).toBeUndefined();
  });

  it('B1 invariant unchanged: SKILL.md with trailing newline still works (body 提取正常)', async () => {
    const skillsDir = '/skills';
    const skillDir = '/skills/bar';
    const fs = mockFs(
      {
        [`${skillDir}/SKILL.md`]:
          '---\nname: bar\n---\nhello body\n',
      },
      [skillsDir, skillDir],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    await sys.loadAll();

    expect(sys.getMeta('bar')?.name).toBe('bar');
  });

  it('B2: duplicate dirName fallback collision → throw SkillDuplicateError + audit DUPLICATE_REJECTED with name_source=fallback_dirname × 2', async () => {
    const skillsDir = '/skills';
    const dir1 = '/skills/foo';
    const dir2 = '/skills/sub/foo';
    // Both SKILL.md 缺 name: → 双 fallback dirName='foo'
    const fs = mockFs(
      {
        [`${dir1}/SKILL.md`]: '---\ndescription: first\n---\n',
        [`${dir2}/SKILL.md`]: '---\ndescription: second\n---\n',
      },
      [skillsDir, dir1, dir2],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    // Manually register both (simulating loadAll discovery order)
    await sys.register(dir1);
    await expect(sys.register(dir2)).rejects.toThrow(SkillDuplicateError);

    const dupAudit = audit.calls.find(
      c => c[0] === 'skill_duplicate_rejected',
    );
    expect(dupAudit).toBeDefined();
    // Assert both name_source fields present + value 'fallback_dirname'
    expect(dupAudit!.slice(1)).toEqual(
      expect.arrayContaining([
        'existing_name_source=fallback_dirname',
        'attempted_name_source=fallback_dirname',
      ]),
    );
  });

  it('B2 hybrid case: existing=frontmatter, attempted=fallback_dirname → throw SkillDuplicateError + audit DUPLICATE_REJECTED recorded distinctly', async () => {
    const skillsDir = '/skills';
    const dir1 = '/skills/explicit';
    const dir2 = '/skills/sub/foo';
    const fs = mockFs(
      {
        [`${dir1}/SKILL.md`]: '---\nname: foo\n---\n', // explicit name='foo'
        [`${dir2}/SKILL.md`]: '---\ndescription: x\n---\n', // fallback dirname='foo'
      },
      [skillsDir, dir1, dir2],
    );
    const audit = mockAudit();
    const sys = new SkillSystem(fs, skillsDir, audit);

    await sys.register(dir1);
    await expect(sys.register(dir2)).rejects.toThrow(SkillDuplicateError);

    const dupAudit = audit.calls.find(
      c => c[0] === 'skill_duplicate_rejected',
    );
    expect(dupAudit).toBeDefined();
    expect(dupAudit!.slice(1)).toEqual(
      expect.arrayContaining([
        'existing_name_source=frontmatter',
        'attempted_name_source=fallback_dirname',
      ]),
    );
  });
});
