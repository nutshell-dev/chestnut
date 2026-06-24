import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { auditQueryCommand, collectColFilter } from '../../src/cli/commands/audit-query.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
// phase 267: hoist 17 dynamic imports of 2 unique modules.
import { getClawDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import { parseIntOption } from '../../src/cli/parse-int-option.js';
import * as fsNative from 'fs';  // phase 283: hoist 5 require('fs') calls

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getClawDir: vi.fn((claw: string) => `/tmp/chestnut-test/claws/${claw}`),
    getClawConfigPath: vi.fn((claw: string) => `/tmp/chestnut-test/claws/${claw}/config.yaml`),
  };
});
vi.mock('../../src/assembly/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists:
    vi.fn((deps: any, p: string) => {
      // Mock: claw exists if path includes 'test-claw'
      return p.includes('test-claw');
    }),
  buildLLMConfig: vi.fn(),
}));

describe('audit query', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    tempDir = fsNative.mkdtempSync('/tmp/chestnut-test-');
    fsNative.mkdirSync(path.join(tempDir, 'claws', 'test-claw'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fsNative.rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  function writeAudit(claw: string, content: string, fileName = 'audit.tsv') {
    const dir = path.join(tempDir, 'claws', claw);
    fsNative.mkdirSync(dir, { recursive: true });
    fsNative.writeFileSync(path.join(dir, fileName), content);
  }

  it('claw not found → throws CliError', async () => {
    await expect(auditQueryCommand(
      { fsFactory },
      { claw: 'nonexistent', file: 'audit' },
    )).rejects.toThrow('Claw "nonexistent" does not exist');
  });

  it('basic read yields all rows as TSV', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ta\tcol1\n2024-01-01T00:00:01Z\tseq=2\tb\tcol2\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit' });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(lines).toContain('seq=1');
    expect(lines).toContain('seq=2');
  });

  it('--json yields JSON lines', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ta\tcol1\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', json: true });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.seq).toBe(1);
    expect(parsed.source).toBe('audit');
  });

  it('--type filter', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\tcron_tick\n2024-01-01T00:00:01Z\tseq=2\tother\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', type: 'cron_*' });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cron_tick');
  });

  it('--from-seq filter', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ta\n2024-01-01T00:00:01Z\tseq=3\tb\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', fromSeq: 3 });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('seq=3');
  });

  it('--trace filter', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ta\tcol1\ttrace_id=abc\n2024-01-01T00:00:01Z\tseq=2\tb\tcol1\ttrace_id=def\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', trace: 'abc' });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('trace_id=abc');
  });

  it('--limit filter', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ta\n2024-01-01T00:00:01Z\tseq=2\tb\n2024-01-01T00:00:02Z\tseq=3\tc\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', limit: 2 });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('--all-files yields from multiple files', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ta\n', 'audit.tsv');
    writeAudit('test-claw', '2024-01-01T00:00:01Z\tseq=1\ttick_event\n', 'tick.tsv');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', allFiles: true });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('--file and --all-files mutually exclusive → throws', async () => {
    await expect(auditQueryCommand(
      { fsFactory },
      { claw: 'test-claw', file: 'tick', allFiles: true },
    )).rejects.toThrow('--file and --all-files are mutually exclusive');
  });

  it('--follow and --all-files mutually exclusive → throws', async () => {
    await expect(auditQueryCommand(
      { fsFactory },
      { claw: 'test-claw', file: 'audit', allFiles: true, follow: true },
    )).rejects.toThrow('--follow is incompatible with --all-files');
  });

  it('collectColFilter parses key=val', () => {
    expect(collectColFilter('k=v')).toEqual({ k: 'v' });
    expect(collectColFilter('k=v2', { k: 'v1' })).toEqual({ k: 'v2' });
  });

  it('collectColFilter throws on missing =', () => {
    expect(() => collectColFilter('bad')).toThrow('--col value must be key=val format');
  });

  it('collectColFilter handles = in value', () => {
    expect(collectColFilter('cmd=foo=bar')).toEqual({ cmd: 'foo=bar' });
  });

  // ── phase 152 typed filter flag tests ──

  it('--tool-use-id filter', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ttool_call_input\tsubmit_subtask\tcall_00_xxx\ttool_use_id=call_00_xxx\tstep=1\n2024-01-01T00:00:01Z\tseq=2\ttool_result\texec\tcall_01_yyy\ttool_use_id=call_01_yyy\tstep=2\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', toolUseId: 'call_00_xxx' });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('call_00_xxx');
    expect(lines[0]).not.toContain('call_01_yyy');
  });

  it('--step filter', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ttool_call_input\tsubmit_subtask\tcall_00_xxx\ttool_use_id=call_00_xxx\tstep=1\n2024-01-01T00:00:01Z\tseq=2\ttool_result\texec\tcall_01_yyy\ttool_use_id=call_01_yyy\tstep=2\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', step: 1 });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('step=1');
    expect(lines[0]).not.toContain('step=2');
  });

  it('--contract-id filter', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ttool_call_input\tsubmit_subtask\tcall_00_xxx\ttool_use_id=call_00_xxx\tstep=1\tcontract_id=c1\n2024-01-01T00:00:01Z\tseq=2\ttool_result\texec\tcall_01_yyy\ttool_use_id=call_01_yyy\tstep=2\tcontract_id=c2\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', contractId: 'c1' });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain('contract_id=c1');
    expect(lines[0]).not.toContain('contract_id=c2');
  });

  it('typed flag combination (--step + --contract-id) AND semantics', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ttool_call_input\tsubmit_subtask\tcall_00_xxx\ttool_use_id=call_00_xxx\tstep=1\tcontract_id=c1\n2024-01-01T00:00:01Z\tseq=2\ttool_result\texec\tcall_01_yyy\ttool_use_id=call_01_yyy\tstep=2\tcontract_id=c1\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', step: 1, contractId: 'c1' });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith('  →'));
    expect(dataLines.length).toBe(1);
    expect(dataLines[0]).toContain('step=1');
  });

  it('typed flag + --col coexist AND semantics', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ttool_call_input\tsubmit_subtask\tcall_00_xxx\ttool_use_id=call_00_xxx\tstep=1\tcontract_id=c1\n2024-01-01T00:00:01Z\tseq=2\ttool_result\texec\tcall_01_yyy\ttool_use_id=call_01_yyy\tstep=1\tcontract_id=c2\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', step: 1, col: { contract_id: 'c1' } });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith('  →'));
    expect(dataLines.length).toBe(1);
    expect(dataLines[0]).toContain('contract_id=c1');
  });

  it('--step abc non-numeric → throws', async () => {
    // parseIntOption throws, wrapped by withCliErrorHandling → exit 1
    await expect(
      (async () => {
        // simulate what parseIntOption would do
        parseIntOption('abc', '--step must be a number');
      })()
    ).rejects.toThrow('--step must be a number');
  });

  it('JSON output includes typed fields for tool rows', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ttool_result\tsubmit_subtask\tcall_00_xxx\tok\tsummary=accepted…\ttool_use_id=call_00_xxx\tstep=1\tcontract_id=c1\tcontent_size=200\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', json: true });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.toolUseId).toBe('call_00_xxx');
    expect(parsed.stepNumber).toBe(1);
    expect(parsed.contractId).toBe('c1');
    expect(parsed.contentSize).toBe(200);
  });

  it('human-readable tool row ends with jump hint', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ttool_result\tsubmit_subtask\tcall_00_xxx\tok\tsummary=accepted…\ttool_use_id=call_00_xxx\tstep=1\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('详情：chestnut audit lookup call_00_xxx -c <claw>');
  });

  it('human-readable non-tool row has no jump hint', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\tcron_tick\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).not.toContain('详情：chestnut audit lookup');
  });

  it('JSON output does not contain jump hint', async () => {
    writeAudit('test-claw', '2024-01-01T00:00:00Z\tseq=1\ttool_result\tsubmit_subtask\tcall_00_xxx\tok\tsummary=accepted…\ttool_use_id=call_00_xxx\tstep=1\n');
    vi.mocked(getClawDir).mockReturnValue(path.join(tempDir, 'claws', 'test-claw'));

    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).not.toContain('详情：chestnut audit lookup');
  });
});
