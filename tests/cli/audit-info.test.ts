import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { auditInfoCommand } from '../../src/cli/commands/audit-info.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import * as fsNative from 'fs';  // phase 282: hoist require('fs') calls in beforeEach/afterEach/writeAudit
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getClawDir: vi.fn((claw: string) => `/tmp/chestnut-test/claws/${claw}`),
    getClawConfigPath: vi.fn((claw: string) => `/tmp/chestnut-test/claws/${claw}/config.yaml`),
  };
});
vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists: vi.fn((deps: any, p: string) => p.includes('test-claw')),
  buildLLMConfig: vi.fn(),
}));

// phase 256: hoist the dynamic import that 6 tests do — vi.mock guarantees this
// resolves to the mocked module, so a top-level import is just as safe and
// avoids the per-test `await import(...)` overhead.
import { getClawDir } from '../../src/core/claw-topology/claw-instance-paths.js';

describe('audit info', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(async () => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    tempDir = await createTrackedTempDir('chestnut-test-');
    fsNative.mkdirSync(path.join(tempDir, 'claws', 'test-claw'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  function writeAudit(claw: string, content: string, fileName = 'audit.tsv') {
    const dir = path.join(tempDir, 'claws', claw);
    fsNative.mkdirSync(dir, { recursive: true });
    fsNative.writeFileSync(path.join(dir, fileName), content);
  }

  it('claw not found → throws CliError', async () => {
    await expect(auditInfoCommand(
      { fsFactory },
      { claw: 'nonexistent' },
    )).rejects.toThrow('Claw "nonexistent" does not exist');
  });

  it('default output includes claw name and files section', async () => {
    writeAudit('test-claw', 'content\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditInfoCommand({ fsFactory }, { claw: 'test-claw' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Claw: test-claw');
    expect(output).toContain('Audit files');
    expect(output).toContain('audit');
    expect(output).toContain('business main');
  });

  it('--json output has correct schema', async () => {
    writeAudit('test-claw', 'content\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditInfoCommand({ fsFactory }, { claw: 'test-claw', json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    const parsed = JSON.parse(output);
    expect(parsed.claw).toBe('test-claw');
    expect(parsed.files).toBeInstanceOf(Array);
    expect(parsed.files[0].is_business_main).toBe(true);
    expect(parsed.schema_routing).toHaveProperty('available');
    expect(parsed.pending_fallback_dumps).toBeInstanceOf(Array);
  });

  it('owner_modules includes all modules for audit file', async () => {
    writeAudit('test-claw', 'content\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditInfoCommand({ fsFactory }, { claw: 'test-claw', json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    const parsed = JSON.parse(output);
    expect(parsed.files[0].owner_modules.length).toBeGreaterThan(0);
    expect(parsed.files[0].registered_types_count).toBeGreaterThan(0);
  });

  it('multi-file aware: lists tick.tsv alongside audit.tsv', async () => {
    writeAudit('test-claw', 'content\n', 'audit.tsv');
    writeAudit('test-claw', 'content\n', 'tick.tsv');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditInfoCommand({ fsFactory }, { claw: 'test-claw', json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    const parsed = JSON.parse(output);
    expect(parsed.files.length).toBe(2);
    const names = parsed.files.map((f: any) => f.name);
    expect(names).toContain('audit');
    expect(names).toContain('tick');
  });

  it('business main star mark on audit file', async () => {
    writeAudit('test-claw', 'content\n', 'audit.tsv');
    writeAudit('test-claw', 'content\n', 'tick.tsv');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditInfoCommand({ fsFactory }, { claw: 'test-claw' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('* audit');
  });

  it('schema_routing available true when fileRouting present (phase 159)', async () => {
    writeAudit('test-claw', 'content\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditInfoCommand({ fsFactory }, { claw: 'test-claw', json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schema_routing.available).toBe(true);
  });
});
