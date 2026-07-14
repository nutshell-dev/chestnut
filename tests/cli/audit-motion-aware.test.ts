import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { auditQueryCommand } from '../../src/cli/commands/audit-query.js';
import { auditInfoCommand } from '../../src/cli/commands/audit-info.js';
import { auditLookupCommand } from '../../src/cli/commands/audit-lookup.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import * as fsNative from 'fs';  // phase 283: hoist 8 require('fs') calls
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

describe('audit CLI motion-aware adaptation (phase 167)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;
  let originalChestnutRoot: string | undefined;

  beforeEach(async () => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    tempDir = await createTrackedTempDir('chestnut-test-');
    originalChestnutRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalChestnutRoot === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalChestnutRoot;
    }
    await cleanupTempDir(tempDir);
  });

  function writeMotionAudit(content: string, fileName = 'audit.tsv') {
    const dir = path.join(tempDir, '.chestnut', 'motion');
    fsNative.mkdirSync(dir, { recursive: true });
    fsNative.writeFileSync(path.join(dir, fileName), content);
  }

  // ── audit query motion-aware ──

  it('audit query -c motion does not throw and reads motion audit.tsv', async () => {
    writeMotionAudit('2024-01-01T00:00:00Z\tseq=1\tturn_start\ttrace_id=t1\n');
    await auditQueryCommand({ fsFactory }, { claw: 'motion', file: 'audit' });
    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('seq=1');
    expect(output).toContain('turn_start');
  });

  it('audit query -c motion with --json', async () => {
    writeMotionAudit('2024-01-01T00:00:00Z\tseq=1\tturn_start\ttrace_id=t1\n');
    await auditQueryCommand({ fsFactory }, { claw: 'motion', file: 'audit', json: true });
    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.seq).toBe(1);
    expect(parsed.source).toBe('audit');
  });

  it('audit query -c motion --all-files lists multiple files', async () => {
    writeMotionAudit('2024-01-01T00:00:00Z\tseq=1\ta\n', 'audit.tsv');
    writeMotionAudit('2024-01-01T00:01:00Z\tseq=1\ttick_event\n', 'tick.tsv');
    await auditQueryCommand({ fsFactory }, { claw: 'motion', file: 'audit', allFiles: true });
    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  // ── audit info motion-aware ──

  it('audit info -c motion lists motion audit files', async () => {
    writeMotionAudit('content\n');
    await auditInfoCommand({ fsFactory }, { claw: 'motion', json: true });
    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    const parsed = JSON.parse(output);
    expect(parsed.claw).toBe('motion');
    expect(parsed.files).toBeInstanceOf(Array);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(parsed.files[0].name).toBe('audit');
  });

  it('audit info -c motion default output includes motion base dir', async () => {
    writeMotionAudit('content\n');
    await auditInfoCommand({ fsFactory }, { claw: 'motion' });
    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Claw: motion');
    expect(output).toContain('Audit files');
  });

  // ── audit lookup motion-aware ──

  it('audit lookup -c motion resolves to motion dialog/current.json', async () => {
    const motionDir = path.join(tempDir, '.chestnut', 'motion');
    fsNative.mkdirSync(path.join(motionDir, 'dialog'), { recursive: true });
    fsNative.writeFileSync(path.join(motionDir, 'audit.tsv'), '');
    const session = {
      version: 2,
      clawId: 'motion',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_00_xxx', name: 'exec', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', content: 'motion dialog content' }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(path.join(motionDir, 'dialog', 'current.json'), JSON.stringify(session));

    await auditLookupCommand({ fsFactory }, 'call_00_xxx', { claw: 'motion', file: 'audit' });
    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Source: current dialog session');
    expect(output).toContain('motion dialog content');
  });

  // ── backward compatibility: nonexistent claw still throws ──

  it('audit query -c nonexistent still throws (backward compatible)', async () => {
    await expect(auditQueryCommand(
      { fsFactory },
      { claw: 'nonexistent', file: 'audit' },
    )).rejects.toThrow('Claw "nonexistent" does not exist');
  });

  it('audit info -c nonexistent still throws (backward compatible)', async () => {
    await expect(auditInfoCommand(
      { fsFactory },
      { claw: 'nonexistent' },
    )).rejects.toThrow('Claw "nonexistent" does not exist');
  });

  it('audit lookup -c nonexistent still throws (backward compatible)', async () => {
    await expect(auditLookupCommand(
      { fsFactory },
      'call_00_xxx',
      { claw: 'nonexistent', file: 'audit' },
    )).rejects.toThrow('Claw "nonexistent" does not exist');
  });

  // ── drift defense: all three subcommands share the same pattern ──

  it('all three subcommands contain the same motion-aware pattern', () => {
    const fs = require('fs');
    const srcDir = path.join(__dirname, '../../src/cli/commands');
    for (const name of ['audit-query.ts', 'audit-info.ts', 'audit-lookup.ts']) {
      const content = fs.readFileSync(path.join(srcDir, name), 'utf-8');
      expect(content).toContain('MOTION_CLAW_ID');
      expect(content).toContain('getNamedSubrootDir');
      expect(content).toContain('isMotion');
      expect(content).toContain('isMotion ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir');
    }
  });
});
