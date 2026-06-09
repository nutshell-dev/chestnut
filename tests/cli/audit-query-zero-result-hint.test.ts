import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { auditQueryCommand } from '../../src/cli/commands/audit-query.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';

const shared = vi.hoisted(() => ({ baseDir: '' }));

vi.mock('../../src/foundation/config/index.js', () => ({
  loadGlobalConfig: vi.fn(),
  clawExists: vi.fn((deps: any, p: string) => p.includes('test-claw') || p.includes('empty-claw')),
  getClawDir: vi.fn((claw: string) => path.join(shared.baseDir, 'claws', claw)),
  getClawConfigPath: vi.fn((claw: string) => path.join(shared.baseDir, 'claws', claw, 'config.yaml')),
}));

function makeMockFs(baseDir: string): FileSystem {
  return new NodeFileSystem({ baseDir }) as FileSystem;
}

describe('audit-query 0 result hint std-2 (phase 216 Step D)', () => {
  let tmpDir: string;
  let fsFactory: (baseDir: string) => FileSystem;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const originalStderrIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'audit-query-hint-'));
    shared.baseDir = tmpDir;
    fsSync.mkdirSync(path.join(tmpDir, 'claws', 'test-claw', '.chestnut'), { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, 'claws', 'test-claw', 'claw.json'), JSON.stringify({ id: 'test-claw', createdAt: new Date().toISOString() }));
    fsSync.writeFileSync(path.join(tmpDir, 'claws', 'test-claw', 'audit.tsv'), [
      '2026-06-09T00:00:00.000Z\tseq=1\tturn_start',
      '2026-06-09T00:00:01.000Z\tseq=2\ttool_call_input\ttool_use_id=call_001\tstep=0\targs_size=12',
      '2026-06-09T00:00:02.000Z\tseq=3\ttool_result\ttool_use_id=call_001\tstep=0\tstatus=ok',
    ].join('\n') + '\n');

    fsFactory = (baseDir: string) => makeMockFs(baseDir);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stderr, 'isTTY', { value: originalStderrIsTTY, configurable: true });
    try {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('0 result on tty: hint 2 line format', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    await auditQueryCommand({ fsFactory }, {
      claw: 'test-claw',
      file: 'audit',
      step: 99,
    });
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      "No audit rows match filter (--step 99) in claw 'test-claw'.\n(3 rows scanned)\n"
    );
  });

  it('0 result on pipe (non-tty): hint 1 line format', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    await auditQueryCommand({ fsFactory }, {
      claw: 'test-claw',
      file: 'audit',
      step: 99,
    });
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      "No audit rows match filter (--step 99) in claw 'test-claw'. (3 rows scanned)\n"
    );
  });

  it('--no-hint suppresses stderr', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    await auditQueryCommand({ fsFactory }, {
      claw: 'test-claw',
      file: 'audit',
      step: 99,
      noHint: true,
    });
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('N>0 match: 0 hint emit', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
    await auditQueryCommand({ fsFactory }, {
      claw: 'test-claw',
      file: 'audit',
      step: 0,
    });
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('multi-filter formatter', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    await auditQueryCommand({ fsFactory }, {
      claw: 'test-claw',
      file: 'audit',
      step: 1,
      toolUseId: 'call_001',
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('(--step 1 --tool-use-id call_001)')
    );
  });

  it('no filter (audit query --claw test-claw alone) 0 match still emits hint with (no filter)', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: false, configurable: true });
    // Use a different claw with empty audit file
    fsSync.mkdirSync(path.join(tmpDir, 'claws', 'empty-claw', '.chestnut'), { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, 'claws', 'empty-claw', 'claw.json'), JSON.stringify({ id: 'empty-claw', createdAt: new Date().toISOString() }));
    fsSync.writeFileSync(path.join(tmpDir, 'claws', 'empty-claw', 'audit.tsv'), '');

    await auditQueryCommand({ fsFactory }, {
      claw: 'empty-claw',
      file: 'audit',
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('(no filter)')
    );
  });
});

describe('audit-query `--no-hint` commander wire (phase 219 Step A)', () => {
  let tmpDir: string;
  let fsFactory: (baseDir: string) => FileSystem;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const originalStderrIsTTY = process.stderr.isTTY;

  beforeEach(() => {
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'audit-query-hint-wire-'));
    shared.baseDir = tmpDir;
    fsSync.mkdirSync(path.join(tmpDir, 'claws', 'test-claw', '.chestnut'), { recursive: true });
    fsSync.writeFileSync(path.join(tmpDir, 'claws', 'test-claw', 'claw.json'), JSON.stringify({ id: 'test-claw', createdAt: new Date().toISOString() }));
    fsSync.writeFileSync(path.join(tmpDir, 'claws', 'test-claw', 'audit.tsv'), [
      '2026-06-09T00:00:00.000Z\tseq=1\tturn_start',
    ].join('\n') + '\n');

    fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stderr, 'isTTY', { value: originalStderrIsTTY, configurable: true });
    try {
      fsSync.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('commander --no-X flag shape: --no-hint produces hint=false, not noHint (regression guard)', async () => {
    const prog = new Command();
    prog.option('--no-hint', 'Suppress hint');
    let captured: any;
    prog.action((opts) => { captured = opts; });
    await prog.parseAsync(['node', 'test', '--no-hint']);
    expect(captured).toHaveProperty('hint', false);
    expect(captured).not.toHaveProperty('noHint');
  });

  it('commander --no-X default: no flag → hint=true (regression guard)', async () => {
    const prog = new Command();
    prog.option('--no-hint', 'Suppress hint');
    let captured: any;
    prog.action((opts) => { captured = opts; });
    await prog.parseAsync(['node', 'test']);
    expect(captured).toHaveProperty('hint', true);
  });

  it('--no-hint through commander wire suppresses stderr (end-to-end opts translation)', async () => {
    // Simulate what cli/index.ts does: parse with commander, then pass noHint: hint === false
    const prog = new Command();
    prog.option('--no-hint', 'Suppress 0 result hint to stderr');
    let actionCalled = false;
    prog.action(async (opts: { hint?: boolean }) => {
      actionCalled = true;
      await auditQueryCommand({ fsFactory }, {
        claw: 'test-claw',
        file: 'audit',
        step: 99,
        noHint: opts.hint === false,
      });
    });
    await prog.parseAsync(['node', 'test', '--no-hint']);
    expect(actionCalled).toBe(true);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('default (no --no-hint) through commander wire emits hint (end-to-end opts translation)', async () => {
    const prog = new Command();
    prog.option('--no-hint', 'Suppress 0 result hint to stderr');
    let actionCalled = false;
    prog.action(async (opts: { hint?: boolean }) => {
      actionCalled = true;
      await auditQueryCommand({ fsFactory }, {
        claw: 'test-claw',
        file: 'audit',
        step: 99,
        noHint: opts.hint === false,
      });
    });
    await prog.parseAsync(['node', 'test']);
    expect(actionCalled).toBe(true);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('No audit rows match filter')
    );
  });
});
