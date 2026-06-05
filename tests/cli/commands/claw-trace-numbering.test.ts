/**
 * claw-trace numbering coherence — phase 1484.
 *
 * Coverage (per `coding plan/phase1484/Phase 1484 总览.md`):
 * - overview uses `Turn N` (not `Round N`)
 * - overview tool index is `[N.x]` (not `[#NN]`), slot resets per turn
 * - multiple tools in same turn → slots a, b, c
 * - header reads `Turns: N` (not `Steps: N`)
 * - `--step 5` defaults to slot a (first tool of turn 5)
 * - `--step 5.b` selects slot b
 * - `--step <invalid>` (e.g. `5x`) → CliError with helpful message
 * - user_notify trigger annotates the *next* turn header
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { clawTraceCommand } from '../../../src/cli/commands/claw-trace.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CliError } from '../../../src/cli/errors.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { makeClawId } from '../../../src/foundation/paths.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

vi.mock('../../../src/foundation/config/index.js', () => ({
  loadGlobalConfig: vi.fn(),
  clawExists: vi.fn(),
  getClawDir: vi.fn(),
}));

interface StreamEv {
  ts: number;
  type: string;
  name?: string;
  success?: boolean;
  subtype?: string;
  delta?: string;
  tool_use_id?: string;
  summary?: string;
}

function writeStream(clawDir: string, events: StreamEv[]): void {
  const lines = events.map((e) => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(clawDir, 'stream-1.jsonl'), lines + '\n');
}

function writeProgress(clawDir: string, contractId: string, startedAt: string, title?: string): void {
  const dir = path.join(clawDir, 'contract', 'active', contractId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'progress.json'),
    JSON.stringify({ started_at: startedAt, title }),
  );
}

describe('claw-trace numbering coherence (phase 1484)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let logs: string[];
  let tmpRoot: string;
  let clawDir: string;
  const startedAt = '2026-05-31T00:00:00.000Z';
  const startedTs = Date.parse(startedAt);

  beforeEach(async () => {
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-trace-test-'));
    clawDir = path.join(tmpRoot, '.chestnut', 'claws', 'alice');
    fs.mkdirSync(clawDir, { recursive: true });

    const { loadGlobalConfig, clawExists, getClawDir } = await import(
      '../../../src/foundation/config/index.js'
    );
    vi.mocked(loadGlobalConfig).mockReturnValue({} as never);
    vi.mocked(clawExists).mockReturnValue(true);
    vi.mocked(getClawDir).mockReturnValue(clawDir as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('header reads `Turns: N` not `Steps: N`', async () => {
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [
      { ts: startedTs + 1, type: 'llm_start' },
      { ts: startedTs + 2, type: 'tool_result', name: 'read', tool_use_id: 't1' },
      { ts: startedTs + 3, type: 'llm_start' },
      { ts: startedTs + 4, type: 'tool_result', name: 'write', tool_use_id: 't2' },
    ]);

    await clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'));
    const out = logs.join('\n');

    expect(out).toContain('Turns: 2');
    expect(out).not.toContain('Steps: ');
  });

  it('overview uses `Turn N` separators (not `Round N`)', async () => {
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [
      { ts: startedTs + 1, type: 'llm_start' },
      { ts: startedTs + 2, type: 'tool_result', name: 'read', tool_use_id: 't1' },
      { ts: startedTs + 3, type: 'llm_start' },
      { ts: startedTs + 4, type: 'tool_result', name: 'write', tool_use_id: 't2' },
    ]);

    await clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'));
    const out = logs.join('\n');

    expect(out).toMatch(/Turn 1\b/);
    expect(out).toMatch(/Turn 2\b/);
    expect(out).not.toMatch(/Round \d/);
  });

  it('tool index is `[N.x]` with slot reset per turn (multi-tool turn → a, b, c)', async () => {
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [
      { ts: startedTs + 1, type: 'llm_start' },
      { ts: startedTs + 2, type: 'tool_result', name: 'read', tool_use_id: 't1' },
      { ts: startedTs + 3, type: 'tool_result', name: 'read', tool_use_id: 't2' },
      { ts: startedTs + 4, type: 'tool_result', name: 'write', tool_use_id: 't3' },
      { ts: startedTs + 5, type: 'llm_start' },
      { ts: startedTs + 6, type: 'tool_result', name: 'submit', tool_use_id: 't4' },
    ]);

    await clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'));
    const out = logs.join('\n');

    expect(out).toContain('[1.a] read');
    expect(out).toContain('[1.b] read');
    expect(out).toContain('[1.c] write');
    expect(out).toContain('[2.a] submit');
    // 反向：旧 [#NN] 形态不应出现
    expect(out).not.toMatch(/\[#\d+\]/);
  });

  it('turn header is printed BEFORE the turn content (phase 1484 fix off-by-one labeling)', async () => {
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [
      { ts: startedTs + 1, type: 'llm_start' },
      { ts: startedTs + 2, type: 'tool_result', name: 'first', tool_use_id: 't1' },
      { ts: startedTs + 3, type: 'llm_start' },
      { ts: startedTs + 4, type: 'tool_result', name: 'second', tool_use_id: 't2' },
    ]);

    await clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'));
    const out = logs.join('\n');

    const idxTurn1 = out.indexOf('Turn 1');
    const idxFirstTool = out.indexOf('[1.a] first');
    const idxTurn2 = out.indexOf('Turn 2');
    const idxSecondTool = out.indexOf('[2.a] second');

    expect(idxTurn1).toBeGreaterThanOrEqual(0);
    expect(idxFirstTool).toBeGreaterThan(idxTurn1);
    expect(idxTurn2).toBeGreaterThan(idxFirstTool);
    expect(idxSecondTool).toBeGreaterThan(idxTurn2);
  });

  it('user_notify trigger annotates the NEXT turn header', async () => {
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [
      { ts: startedTs + 1, type: 'llm_start' },
      { ts: startedTs + 2, type: 'tool_result', name: 'submit', tool_use_id: 't1' },
      { ts: startedTs + 3, type: 'user_notify', subtype: 'subtask_completed' },
      { ts: startedTs + 4, type: 'llm_start' },
      { ts: startedTs + 5, type: 'tool_result', name: 'next', tool_use_id: 't2' },
    ]);

    await clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'));
    const out = logs.join('\n');

    expect(out).toMatch(/Turn 2 \(subtask_completed\)/);
    // 第一个 Turn 1 不应带 trigger
    const turn1Match = out.match(/Turn 1[^\n]*/);
    expect(turn1Match?.[0]).not.toContain('subtask_completed');
  });

  it('--step 5 form (no slot) is accepted (defaults to slot a)', async () => {
    // 写仅 1 turn, 1 tool 的 trace。
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [
      { ts: startedTs + 1, type: 'llm_start' },
      { ts: startedTs + 2, type: 'tool_result', name: 'mytool', tool_use_id: 't1' },
    ]);

    await clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'), '1');
    const out = logs.join('\n');
    expect(out).toContain('[1.a] mytool');
  });

  it('--step 1.b form selects slot b', async () => {
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [
      { ts: startedTs + 1, type: 'llm_start' },
      { ts: startedTs + 2, type: 'tool_result', name: 'first', tool_use_id: 't1' },
      { ts: startedTs + 3, type: 'tool_result', name: 'second', tool_use_id: 't2' },
    ]);

    await clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'), '1.b');
    const out = logs.join('\n');
    expect(out).toContain('[1.b] second');
    expect(out).not.toContain('[1.a]');
  });

  it('--step "5x" (invalid) raises CliError', async () => {
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [{ ts: startedTs + 1, type: 'llm_start' }]);

    await expect(
      clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'), '5x'),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('--step 99.a (out of range) raises CliError', async () => {
    writeProgress(clawDir, 'C-1', startedAt);
    writeStream(clawDir, [
      { ts: startedTs + 1, type: 'llm_start' },
      { ts: startedTs + 2, type: 'tool_result', name: 'mytool', tool_use_id: 't1' },
    ]);

    await expect(
      clawTraceCommand({ fsFactory }, makeClawId('alice'), makeContractId('C-1'), '99.a'),
    ).rejects.toBeInstanceOf(CliError);
  });
});
