import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import * as path from 'path';
import { auditQueryCommand } from '../../src/cli/commands/audit-query.js';
import { auditLookupCommand } from '../../src/cli/commands/audit-lookup.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import type { FileSystem } from '../../src/foundation/fs/types.js';
import { getClawDir } from '../../src/core/claw-topology/claw-instance-paths.js';
import * as fsNative from 'fs';  // phase 283: hoist 6 require('fs') calls

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../src/core/claw-topology/claw-instance-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/claw-topology/claw-instance-paths.js')>();
  return {
    ...actual,
    getClawDir: vi.fn((claw: string) => `/tmp/chestnut-test/claws/${claw}`),
    getClawConfigPath: vi.fn((claw: string) => `/tmp/chestnut-test/claws/${claw}/config.yaml`),
  };
});
vi.mock('../../src/assembly/config/config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/assembly/config/config-loader.js')>();
  return {
    ...actual,
  };
});
vi.mock('../../src/assembly/config/config-load.js', async () => ({
  loadGlobalConfig: vi.fn(),
  isInitialized: vi.fn(),
  saveGlobalConfig: vi.fn(),
  loadClawConfig: vi.fn(),
  patchGlobalConfigPrimary: vi.fn(),
  saveClawConfig: vi.fn(),
  clawExists:
    vi.fn((deps: any, p: string) => {
      return p.includes('test-claw');
    }),
  buildLLMConfig: vi.fn(),
}));

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function buildFixture() {
  const tmpDir = fsNative.mkdtempSync('/tmp/phase152-cross-cli-');
  const clawDir = path.join(tmpDir, 'claws', 'test-claw');
  fsNative.mkdirSync(clawDir, { recursive: true });

  // audit.tsv: 5 tool rows + 3 lifecycle rows
  const auditRows = [
    '2026-06-07T10:00:00.000Z\tseq=1\tturn_start\ttrace_id=t1',
    '2026-06-07T10:00:01.000Z\tseq=2\ttool_call_input\tsubmit_subtask\tcall_00_xxx\ttool_use_id=call_00_xxx\tstep=1\tcontract_id=c1\ttrace_id=t1',
    '2026-06-07T10:00:02.000Z\tseq=3\ttool_result\tsubmit_subtask\tcall_00_xxx\tok\tsummary=accepted full content preview…\ttool_use_id=call_00_xxx\tstep=1\tcontract_id=c1\tcontent_size=200\ttrace_id=t1',
    '2026-06-07T10:00:03.000Z\tseq=4\ttool_call_input\texec\tcall_01_yyy\ttool_use_id=call_01_yyy\tstep=2\tcontract_id=c1\ttrace_id=t1',
    '2026-06-07T10:00:04.000Z\tseq=5\ttool_result\texec\tcall_01_yyy\tok\tsummary=exec done…\ttool_use_id=call_01_yyy\tstep=2\tcontract_id=c1\tcontent_size=150\ttrace_id=t1',
    '2026-06-07T10:00:05.000Z\tseq=6\tturn_end\ttrace_id=t1',
  ];
  fsNative.writeFileSync(path.join(clawDir, 'audit.tsv'), auditRows.join('\n') + '\n');

  // dialog/current.json: SessionData with ToolUseBlock/ToolResultBlock
  fsNative.mkdirSync(path.join(clawDir, 'dialog'), { recursive: true });
  const session = {
    version: 2,
    clawId: 'test-claw',
    createdAt: '2026-06-07T10:00:00.000Z',
    updatedAt: '2026-06-07T10:00:05.000Z',
    systemPrompt: 'test',
    trace_id: 't1',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_00_xxx', name: 'submit_subtask', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_00_xxx', content: 'accepted full content here' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_01_yyy', name: 'exec', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_01_yyy', content: 'exec output here' }] },
    ],
    toolsForLLM: [],
  };
  fsNative.writeFileSync(path.join(clawDir, 'dialog', 'current.json'), JSON.stringify(session));

  return {
    tmpDir,
    clawDir,
    tearDown: () => {
      try {
        fsNative.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

describe('cross-CLI id consistency (phase 152 §5.B SoT guard)', () => {
  let fixture: { tmpDir: string; clawDir: string; tearDown: () => void };

  beforeAll(() => {
    fixture = buildFixture();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterAll(() => {
    fixture.tearDown();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    stdoutSpy.mockClear();
    stderrSpy.mockClear();
    vi.mocked(getClawDir).mockReturnValue(fixture.clawDir);
  });

  it('audit query --step N row contains step=N col (consistency with motion step / claw step N)', async () => {
    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', step: 1 });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      // Skip jump hint lines
      if (line.startsWith('  →')) continue;
      expect(line).toContain('step=1');
    }
    // All matched rows should share the same trace_id
    const traceIds = new Set(
      lines
        .filter(l => !l.startsWith('  →'))
        .map(l => l.match(/trace_id=([^\t]+)/)?.[1])
        .filter(Boolean),
    );
    expect(traceIds.size).toBe(1);
  });

  it('audit query --contract-id c1 all tool rows contain contract_id=c1', async () => {
    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', contractId: 'c1' });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith('  →'));
    for (const line of dataLines) {
      // Only check tool rows (they have tool_use_id col)
      if (line.includes('tool_use_id=')) {
        expect(line).toContain('contract_id=c1');
      }
    }
  });

  it('audit query --tool-use-id call_00_xxx hits tool_call_input + tool_result 2 rows', async () => {
    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', toolUseId: 'call_00_xxx' });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    const dataLines = lines.filter(l => !l.startsWith('  →'));
    const types = dataLines.map(l => l.split('\t')[2]);
    expect(types).toContain('tool_call_input');
    expect(types).toContain('tool_result');

    // Same tool_use_id implies same step / contract / trace_id
    const stepNums = new Set(dataLines.map(l => l.match(/step=(\d+)/)?.[1]).filter(Boolean));
    expect(stepNums.size).toBe(1);
    const contractIds = new Set(dataLines.map(l => l.match(/contract_id=([^\t]+)/)?.[1]).filter(Boolean));
    expect(contractIds.size).toBe(1);
    const traceIds = new Set(dataLines.map(l => l.match(/trace_id=([^\t]+)/)?.[1]).filter(Boolean));
    expect(traceIds.size).toBe(1);
  });

  it('audit lookup call_00_xxx returns current source with full content', async () => {
    await auditLookupCommand({ fsFactory }, 'call_00_xxx', { claw: 'test-claw', file: 'audit' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('Source: current dialog session');
    expect(output).toContain('accepted full content here');
    // Full content in dialog is longer than audit summary preview
    expect(output.length).toBeGreaterThan('accepted'.length);
  });

  it('audit lookup non-existent tool_use_id → unavailable + reason all_failed', async () => {
    await auditLookupCommand({ fsFactory }, 'call_99_nonexistent', { claw: 'test-claw', file: 'audit' });

    const errOutput = stderrSpy.mock.calls.map(c => c[0] as string).join('');
    expect(errOutput).toContain('reason=all_failed');
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it('audit query --step 1 JSON output contains typed ID fields (stepNumber === 1)', async () => {
    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', step: 1, json: true });

    const lines = stdoutSpy.mock.calls.map(c => c[0] as string).join('').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.stepNumber).toBe(1);
      expect(parsed.toolUseId).toBeDefined();
    }
  });

  it('human-readable tool row ends with jump hint containing audit lookup <toolUseId>', async () => {
    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', toolUseId: 'call_00_xxx' });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).toContain('详情：chestnut audit lookup call_00_xxx -c <claw>');
  });

  it('JSON output does not contain jump hint lines', async () => {
    await auditQueryCommand({ fsFactory }, { claw: 'test-claw', file: 'audit', toolUseId: 'call_00_xxx', json: true });

    const output = stdoutSpy.mock.calls.map(c => c[0] as string).join('');
    expect(output).not.toContain('详情：chestnut audit lookup');
  });
});
