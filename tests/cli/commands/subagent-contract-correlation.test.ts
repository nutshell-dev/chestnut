import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { subagentListCommand } from '../../../src/cli/commands/subagent-list.js';
import { scanSubagentResults } from '../../../src/cli/commands/subagent-helpers.js';
import {
  createSubagentExecutionStore,
  TASKS_SYNC_SUBAGENT_DIR,
  type SubagentJsonValue,
} from '../../../src/core/subagent/index.js';
import { getClawDir } from '../../../src/foundation/claw-identity/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

const CLAW_ID = 'contract-correlation';
const CONTRACT_A = 'contract-a';
const CONTRACT_B = 'contract-b';
const EXECUTION_NOW_MS = 1_700_000_000_000;
const fsFactory = (baseDir: string): NodeFileSystem => new NodeFileSystem({ baseDir });

type ListOptions = Parameters<typeof subagentListCommand>[1];
interface ListPayload {
  entries: Array<{
    id: string;
    contract_id: string | null;
    contract_correlation: {
      kind: 'known' | 'unknown';
      source?: 'execution_input' | 'legacy_name';
      reason?: string;
    } | null;
  }>;
  total: number;
  incomplete: boolean;
  correlation_issues: Array<{ id: string; reason: string }>;
}

describe('Phase 2249 Step E: CLI contract correlation', () => {
  let tempDir: string;
  let clawDir: string;
  let clawFs: NodeFileSystem;
  let originalRoot: string | undefined;
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalRoot = process.env.CHESTNUT_ROOT;
    tempDir = await createTrackedTempDir('chestnut-phase2249-cli-correlation-');
    process.env.CHESTNUT_ROOT = tempDir;
    clawDir = getClawDir(CLAW_ID);
    await fsp.mkdir(clawDir, { recursive: true });
    clawFs = fsFactory(clawDir);
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLog.mockRestore();
    if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalRoot;
    await cleanupTempDir(tempDir);
  });

  function executionInput(runId: string, resultDir: string, currentContractId?: SubagentJsonValue): SubagentJsonValue {
    return {
      schema_version: 1,
      kind: 'run_subagent_options',
      agentId: runId,
      clawDir,
      syncDir: path.join(clawDir, 'tasks/sync'),
      resultDir,
      prompt: `prompt for ${runId}`,
      ...(currentContractId !== undefined ? { currentContractId } : {}),
    };
  }

  async function seedModern(
    runId: string,
    currentContractId?: SubagentJsonValue,
    options: { settled?: boolean } = {},
  ) {
    const resultDir = path.join(TASKS_SYNC_SUBAGENT_DIR, runId);
    const location = { runId, resultDir };
    const store = createSubagentExecutionStore({
      fs: clawFs,
      resultDir,
      newAttemptId: () => `physical-attempt-${runId}`,
      now: () => EXECUTION_NOW_MS,
    });
    const prepared = await store.prepareInput(location, executionInput(runId, resultDir, currentContractId));
    const claimed = await store.claimAttempt({
      location,
      inputDigest: prepared.document.inputDigest,
      ordinal: 1,
      parentAttemptId: null,
      startBasis: 'start',
    });
    if (claimed.kind !== 'claimed') throw new Error('expected a new execution claim');
    await claimed.writer.transition({ state: 'prepared' });
    await claimed.writer.transition({ state: 'running' });
    if (options.settled) {
      await claimed.writer.settle({ kind: 'completed', content: 'completed result', rawResult: { ok: true } });
      await clawFs.writeAtomic(path.join(resultDir, 'result.txt'), 'completed result');
    }
    return location;
  }

  async function seedLegacy(runId: string): Promise<void> {
    await clawFs.writeAtomic(path.join(TASKS_SYNC_SUBAGENT_DIR, runId, 'result.txt'), `legacy ${runId}`);
  }

  async function scan() {
    return scanSubagentResults({ fsFactory }, clawDir);
  }

  async function captureList(options: Partial<ListOptions> = {}): Promise<string[]> {
    consoleLog.mockClear();
    await subagentListCommand({ fsFactory }, { ...options, claw: CLAW_ID });
    return consoleLog.mock.calls.map(call => call.map(String).join(' '));
  }

  async function listJson(options: Partial<ListOptions> = {}): Promise<ListPayload> {
    const lines = await captureList({ ...options, json: true });
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]) as ListPayload;
  }

  it('uses execution_input for attempt-only modern records and never falls back to a misleading directory contract', async () => {
    const attemptOnly = 'verifier-attempt-10000000-0000-0000-0000-000000000001';
    const misleadingName = 'verifier-contract-b-1';
    await seedModern(attemptOnly, CONTRACT_A);
    await seedModern(misleadingName, CONTRACT_A);

    const scanned = await scan();
    expect(scanned).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: attemptOnly,
        contractId: CONTRACT_A,
        contractCorrelation: { kind: 'known', contractId: CONTRACT_A, source: 'execution_input' },
      }),
      expect.objectContaining({
        id: misleadingName,
        contractId: CONTRACT_A,
        contractCorrelation: { kind: 'known', contractId: CONTRACT_A, source: 'execution_input' },
      }),
    ]));

    const matchesA = await listJson({ contract: CONTRACT_A });
    expect(matchesA.entries.map(entry => entry.id).sort()).toEqual([attemptOnly, misleadingName].sort());
    expect(matchesA.incomplete).toBe(false);
    const matchesB = await listJson({ contract: CONTRACT_B });
    expect(matchesB.entries).toEqual([]);
    expect(matchesB.total).toBe(0);
    expect(matchesB.correlation_issues).toEqual([]);
  });

  it('retains absent/bad modern correlations with reasons, text diagnostics and incomplete empty filtered results', async () => {
    const absent = 'verifier-attempt-20000000-0000-0000-0000-000000000001';
    const badField = 'verifier-attempt-20000000-0000-0000-0000-000000000002';
    await seedModern(absent);
    await seedModern(badField, 42);

    const scanned = await scan();
    expect(scanned.find(entry => entry.id === absent)).toMatchObject({
      contractCorrelation: { kind: 'unknown', reason: 'execution input has no currentContractId' },
    });
    expect(scanned.find(entry => entry.id === badField)).toMatchObject({
      contractCorrelation: { kind: 'unknown', reason: 'currentContractId is not a non-empty string' },
    });

    const ordinary = await listJson();
    expect(ordinary.entries.find(entry => entry.id === absent)).toMatchObject({
      contract_id: null,
      contract_correlation: { kind: 'unknown', reason: 'execution input has no currentContractId' },
    });
    expect(ordinary.entries.find(entry => entry.id === badField)).toMatchObject({
      contract_id: null,
      contract_correlation: { kind: 'unknown', reason: 'currentContractId is not a non-empty string' },
    });

    const text = (await captureList()).join('\n');
    expect(text).toContain(`Contract correlation unknown: ${absent}: execution input has no currentContractId`);
    expect(text).toContain(`Contract correlation unknown: ${badField}: currentContractId is not a non-empty string`);

    const filtered = await listJson({ contract: CONTRACT_A });
    expect(filtered.entries).toEqual([]);
    expect(filtered.incomplete).toBe(true);
    expect(filtered.correlation_issues).toEqual(expect.arrayContaining([
      { id: absent, reason: 'execution input has no currentContractId' },
      { id: badField, reason: 'currentContractId is not a non-empty string' },
    ]));
  });

  it('mixes a legacy fixed-name known correlation with an attempt-only unknown without confusing their sources', async () => {
    const known = 'verifier-contract-legacy-1';
    const unknown = 'verifier-attempt-30000000-0000-0000-0000-000000000001';
    await seedLegacy(known);
    await seedLegacy(unknown);

    const scanned = await scan();
    expect(scanned.find(entry => entry.id === known)).toMatchObject({
      source: 'legacy',
      contractId: 'contract-legacy',
      contractCorrelation: { kind: 'known', contractId: 'contract-legacy', source: 'legacy_name' },
    });
    expect(scanned.find(entry => entry.id === unknown)).toMatchObject({
      source: 'legacy',
      contractCorrelation: { kind: 'unknown', reason: 'legacy verifier name has no reliable contract association' },
    });

    const filtered = await listJson({ contract: 'contract-legacy' });
    expect(filtered.entries).toHaveLength(1);
    expect(filtered.entries[0]).toMatchObject({
      id: known,
      contract_id: 'contract-legacy',
      contract_correlation: { kind: 'known', source: 'legacy_name' },
    });
    expect(filtered.incomplete).toBe(true);
    expect(filtered.correlation_issues).toEqual([
      { id: unknown, reason: 'legacy verifier name has no reliable contract association' },
    ]);
  });

  it('keeps an unknown issue outside the contract-filtered limit=1 result page', async () => {
    const known = 'verifier-contract-limit-1';
    const unknown = 'verifier-attempt-40000000-0000-0000-0000-000000000001';
    await seedLegacy(known);
    await seedLegacy(unknown);

    const payload = await listJson({ contract: 'contract-limit', limit: '1' });
    expect(payload.entries.map(entry => entry.id)).toEqual([known]);
    expect(payload.total).toBe(1);
    expect(payload.incomplete).toBe(true);
    expect(payload.correlation_issues).toEqual([
      { id: unknown, reason: 'legacy verifier name has no reliable contract association' },
    ]);
    expect(payload.entries.some(entry => entry.id === unknown)).toBe(false);
  });

  it('repeats scans/commands without changing any execution/result bytes or adding attempts', async () => {
    const runId = 'verifier-attempt-50000000-0000-0000-0000-000000000001';
    const location = await seedModern(runId, CONTRACT_A, { settled: true });
    const before = await snapshotDigests(clawDir);
    const resultDir = location.resultDir.split(path.sep).join('/');
    expect(Object.keys(before)).toEqual(expect.arrayContaining([
      `${resultDir}/execution/input.json`,
      `${resultDir}/execution/attempts/1/claim.json`,
      `${resultDir}/execution/attempts/1/outcome.json`,
      `${resultDir}/result.txt`,
    ]));

    const first = await listJson({ contract: CONTRACT_A });
    const second = await listJson({ contract: CONTRACT_A });
    await scan();
    expect(first.entries.map(entry => entry.id)).toEqual([runId]);
    expect(second.entries.map(entry => entry.id)).toEqual([runId]);
    expect(await snapshotDigests(clawDir)).toEqual(before);
    expect(await fsp.readdir(path.join(clawDir, location.resultDir, 'execution/attempts'))).toEqual(['1']);
  });
});

async function snapshotDigests(root: string, relative = '.'): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshotDigests(root, child));
    else if (entry.isFile()) {
      const bytes = await fsp.readFile(path.join(root, child));
      result[child.split(path.sep).join('/')] = createHash('sha256').update(bytes).digest('hex');
    }
  }
  return result;
}
