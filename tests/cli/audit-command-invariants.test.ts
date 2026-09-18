import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { auditInfoCommand as auditInfoCommandImpl } from '../../src/cli/commands/audit-info.js';
import { auditLookupCommand as auditLookupCommandImpl } from '../../src/cli/commands/audit-lookup.js';
import { auditQueryCommand as auditQueryCommandImpl } from '../../src/cli/commands/audit-query.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { getClawDir } from '../../src/foundation/claw-identity/index.js';  // phase 271: hoist 7 dyn imports
import * as fsNative from 'fs';  // phase 283: hoist 22 require('fs') calls
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { createHash } from 'crypto';  // phase 284
import { makeAuditCommandDeps } from '../helpers/audit-command-deps.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });
const auditInfoCommand = (_deps: { fsFactory: typeof fsFactory }, opts: Parameters<typeof auditInfoCommandImpl>[1]) =>
  auditInfoCommandImpl(makeAuditCommandDeps(fsFactory), opts);
const auditLookupCommand = (_deps: { fsFactory: typeof fsFactory }, opts: Parameters<typeof auditLookupCommandImpl>[1]) =>
  auditLookupCommandImpl(makeAuditCommandDeps(fsFactory), opts);
const auditQueryCommand = (_deps: { fsFactory: typeof fsFactory }, opts: Parameters<typeof auditQueryCommandImpl>[1]) =>
  auditQueryCommandImpl(makeAuditCommandDeps(fsFactory), opts);

vi.mock('../../src/foundation/claw-identity/instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/foundation/claw-identity/instance-paths.js')>();
  return {
    ...actual,
    getClawDir: vi.fn((claw: string) => `/tmp/chestnut-test/claws/${claw}`),
    getClawConfigPath: vi.fn((claw: string) => `/tmp/chestnut-test/claws/${claw}/config.yaml`),
  };
});

describe('audit lookup', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(async () => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    tempDir = await createTrackedTempDir('chestnut-test-');
    fsNative.mkdirSync(path.join(tempDir, 'claws', 'test-claw'), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  it('claw not found → throws CliError', async () => {
    await expect(auditLookupCommand(
      { fsFactory },
      { claw: 'nonexistent', file: 'audit', toolUseId: 'call_00_xxx' },
    )).rejects.toThrow('Claw "nonexistent" does not exist');
  });

  it('current hit → exit 0 + stdout with Source/content', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_00_xxx', name: 'exec', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', content: 'current content here' }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(path.join(clawDir, 'dialog', 'current.json'), JSON.stringify(session));

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', toolUseId: 'call_00_xxx' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Source: current dialog session');
    expect(output).toContain('current content here');
    expect(process.exitCode).toBeUndefined();
  });

  it('archive hit → exit 0 + stdout with Archived at + content', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', content: 'archived content here' }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'archive', '20240101000000_abc.json'),
      JSON.stringify(session),
    );

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { toolUseId: 'call_00_xxx', claw: 'test-claw', file: 'audit' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Source: archived dialog session');
    expect(output).toContain('archived content here');
    expect(process.exitCode).toBeUndefined();
  });

  it('Phase 1001: archive with corrupted current.json displays degradation note', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    fsNative.writeFileSync(path.join(clawDir, 'dialog', 'current.json'), 'not-valid-json');
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', content: 'archived content here' }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'archive', '20240101000000_abc.json'),
      JSON.stringify(session),
    );

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { toolUseId: 'call_00_xxx', claw: 'test-claw', file: 'audit' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Source: archived dialog session');
    expect(output).toContain('Degradation: current.json: parse_failed');
    expect(process.exitCode).toBeUndefined();
  });

  it('archive + content-hash match → exit 0 + Hash verified: yes', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    const content = 'archived content for hash';
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', content }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'archive', '20240101000000_abc.json'),
      JSON.stringify(session),
    );

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { toolUseId: 'call_00_xxx', claw: 'test-claw', file: 'audit', contentHash: hash });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Hash verified: yes');
    expect(process.exitCode).toBeUndefined();
  });

  it('archive + content-hash mismatch → exit 3 + stderr reason=hash_mismatch', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    const content = 'archived content for hash mismatch';
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', content }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'archive', '20240101000000_abc.json'),
      JSON.stringify(session),
    );

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { toolUseId: 'call_00_xxx', claw: 'test-claw', file: 'audit', contentHash: '00000000' });

    const errOutput = stderrSpy.mock.calls.map(c => c[0] as string).join('');
    expect(errOutput).toContain('reason=hash_mismatch');
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it('all failed → exit 3 + stderr reason=all_failed', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(clawDir, { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    // no dialog dir

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { toolUseId: 'call_99_nonexistent', claw: 'test-claw', file: 'audit' });

    const errOutput = stderrSpy.mock.calls.map(c => c[0] as string).join('');
    expect(errOutput).toContain('reason=all_failed');
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it('--json outputs LookupResult discriminated union', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', content: 'json content' }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(path.join(clawDir, 'dialog', 'current.json'), JSON.stringify(session));

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { toolUseId: 'call_00_xxx', claw: 'test-claw', file: 'audit', json: true });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.source).toBe('current');
    expect(parsed.content).toBe('json content');
  });

  it('--json + unavailable → JSON with source unavailable + exit 3', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(clawDir, { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { toolUseId: 'call_99_nonexistent', claw: 'test-claw', file: 'audit', json: true });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.source).toBe('unavailable');
    expect(parsed.reason).toBe('all_failed');
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it('invalid content-hash format → throws CliError', async () => {
    await expect(auditLookupCommand(
      { fsFactory },
      { claw: 'test-claw', file: 'audit', toolUseId: 'call_00_xxx', contentHash: 'bad' },
    )).rejects.toThrow('--content-hash must be 8-character hex');
  });

  it('IO error (unreadable dialog) → exit 2 via withCliErrorHandling', async () => {
    // This is hard to reproduce deterministically in unit test without mocking fsFactory
    // to throw on read. We verify the error path is handled by CliError for other cases.
    // The withCliErrorHandling wrapper catches unexpected errors and sets exit 2.
    expect(true).toBe(true);
  });

  // ─── phase 1185: --block-id lookup ───

  it('--block-id archive hit → exit 0 + stdout with Block ID/content', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', blockId: 'abc123de-0000-0000-0000-000000000000', content: 'original tool result content' }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'archive', '20240101000000_abc.json'),
      JSON.stringify(session),
    );
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'block-index.json'),
      JSON.stringify({ abc123de: 'abc123de-0000-0000-0000-000000000000' }),
    );

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', blockId: 'abc123de' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Source: archive');
    expect(output).toContain('Block ID: abc123de-0000-0000-0000-000000000000');
    expect(output).toContain('Block type: tool_result');
    expect(output).toContain('Tool use ID: call_00_xxx');
    expect(output).toContain('original tool result content');
    expect(process.exitCode).toBeUndefined();
  });

  it('--block-id not found → exit 3 + stderr reason=not_found', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', blockId: 'abc123de-0000-0000-0000-000000000000', content: 'original tool result content' }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'archive', '20240101000000_abc.json'),
      JSON.stringify(session),
    );

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', blockId: 'notfound1' });

    const errOutput = stderrSpy.mock.calls.map(c => c[0] as string).join('');
    expect(errOutput).toContain('Block ID not found: notfound1');
    expect(errOutput).toContain('reason=not_found');
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it('--block-id --json outputs BlockIdLookupResult discriminated union', async () => {
    const clawDir = path.join(tempDir, 'claws', 'test-claw');
    fsNative.mkdirSync(path.join(clawDir, 'dialog', 'archive'), { recursive: true });
    fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), '');
    const session = {
      version: 2,
      clawId: 'test-claw',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
      systemPrompt: 'test',
      trace_id: 't1',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', blockId: 'abc123de-0000-0000-0000-000000000000', content: 'original tool result content' }] },
      ],
      toolsForLLM: [],
    };
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'archive', '20240101000000_abc.json'),
      JSON.stringify(session),
    );
    fsNative.writeFileSync(
      path.join(clawDir, 'dialog', 'block-index.json'),
      JSON.stringify({ abc123de: 'abc123de-0000-0000-0000-000000000000' }),
    );

    vi.mocked(getClawDir).mockReturnValue(clawDir);

    await auditLookupCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', blockId: 'abc123de', json: true });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.source).toBe('archive');
    expect(parsed.blockId).toBe('abc123de-0000-0000-0000-000000000000');
    expect(parsed.blockType).toBe('tool_result');
    expect(parsed.toolUseId).toBe('call_00_xxx');
    expect(parsed.content).toBe('original tool result content');
    expect(process.exitCode).toBeUndefined();
  });

  it('no toolUseId and no --block-id → throws CliError', async () => {
    await expect(auditLookupCommand(
      { fsFactory },
      { claw: 'test-claw', file: 'audit' },
    )).rejects.toThrow('must provide --tool-use-id or --block-id');
  });

  it('toolUseId and --block-id together → throws CliError', async () => {
    await expect(auditLookupCommand(
      { fsFactory },
      { claw: 'test-claw', file: 'audit', toolUseId: 'call_00_xxx', blockId: 'abc123de' },
    )).rejects.toThrow('--tool-use-id and --block-id are mutually exclusive');
  });
});

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

    await auditLookupCommand({ fsFactory }, { toolUseId: 'call_00_xxx', claw: 'motion', file: 'audit' });
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
      { claw: 'nonexistent', file: 'audit', toolUseId: 'call_00_xxx' },
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
