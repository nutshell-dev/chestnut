/**
 * claw-ls command tests — phase 1480.
 *
 * Integration style (real tmpdir + NodeFileSystem) matching
 * tests/cli/claw-send-confinement.test.ts convention. Covers:
 *
 * - lists clawspace root entries (default path)
 * - lists a subdir within clawspace
 * - --recursive lists nested entries
 * - --json emits JSON FileEntry view
 * - unknown claw → CliError
 * - path escape (`..`) → CliError
 * - dirs sort before files / alphabetical within group
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { lsCommand } from '../../../src/cli/commands/claw-ls.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CliError } from '../../../src/cli/errors.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../../src/assembly/global-config-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/assembly/global-config-path.js')>();
  return {
    ...actual,
    getGlobalConfigPath: vi.fn(),
  };
});
vi.mock('../../../src/foundation/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/foundation/config/index.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../../src/assembly/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn(() => true),
  buildLLMConfig: vi.fn(),
}));

describe('claw-ls (phase 1480)', () => {
  let tmpRoot: string;
  let clawspace: string;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = path.join(os.tmpdir(), `phase1480-ls-${randomUUID()}`);
    // Layout under <tmp>/.chestnut/claws/test-claw/ (mirrors getClawDir()):
    //   .../clawspace/a.md
    //   .../clawspace/b.md
    //   .../clawspace/notes/inner.md
    const clawDir = path.join(tmpRoot, '.chestnut', 'claws', 'test-claw');
    clawspace = path.join(clawDir, 'clawspace');
    fs.mkdirSync(clawspace, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: test-claw\n');
    fs.writeFileSync(path.join(clawspace, 'a.md'), 'aaa');
    fs.writeFileSync(path.join(clawspace, 'b.md'), 'bbb');
    fs.mkdirSync(path.join(clawspace, 'notes'));
    fs.writeFileSync(path.join(clawspace, 'notes', 'inner.md'), 'inner');
    process.env.CHESTNUT_ROOT = tmpRoot;

    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    delete process.env.CHESTNUT_ROOT;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('default path lists clawspace root entries (dirs first, alphabetical)', async () => {
    await lsCommand({ fsFactory }, 'test-claw', undefined, {});
    const out = writes.join('');
    expect(out).toContain('notes/');
    expect(out).toContain('a.md');
    expect(out).toContain('b.md');
    // dir sorted before files
    expect(out.indexOf('notes/')).toBeLessThan(out.indexOf('a.md'));
    expect(out.indexOf('a.md')).toBeLessThan(out.indexOf('b.md'));
  });

  it('lists a subdirectory (path is workspace-relative, unix `cd` intuition)', async () => {
    await lsCommand({ fsFactory }, 'test-claw', 'notes', {});
    const out = writes.join('');
    expect(out).toContain('inner.md');
    expect(out).not.toContain('a.md');
  });

  it('--recursive includes nested files', async () => {
    await lsCommand({ fsFactory }, 'test-claw', undefined, { recursive: true });
    const out = writes.join('');
    expect(out).toContain('a.md');
    expect(out).toContain('b.md');
    expect(out).toContain('inner.md');
  });

  it('--json emits parseable JSON with size + mtime + isDirectory', async () => {
    await lsCommand({ fsFactory }, 'test-claw', undefined, { json: true });
    const out = writes.join('');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    const names = parsed.map((e: { name: string }) => e.name);
    expect(names).toContain('notes');
    expect(names).toContain('a.md');
    const aEntry = parsed.find((e: { name: string }) => e.name === 'a.md');
    expect(aEntry.size).toBe(3);
    expect(typeof aEntry.mtime).toBe('string');
    expect(aEntry.isDirectory).toBe(false);
    const notesEntry = parsed.find((e: { name: string }) => e.name === 'notes');
    expect(notesEntry.isDirectory).toBe(true);
  });

  it('unknown claw throws CliError', async () => {
    const { clawExists } = await import('../../../src/assembly/config-load.js');
    vi.mocked(clawExists).mockReturnValueOnce(false);
    await expect(
      lsCommand({ fsFactory }, 'no-such-claw', undefined, {}),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('path escape (..) throws CliError', async () => {
    await expect(
      lsCommand({ fsFactory }, 'test-claw', '../../../etc', {}),
    ).rejects.toBeInstanceOf(CliError);
  });
});
