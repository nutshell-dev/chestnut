import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createSubagentExecutionStore,
  querySubagentExecution,
  type SubagentExecutionState,
} from '../../src/core/subagent/index.js';
import { TASKS_SYNC_SPAWN_DIR } from '../../src/core/spawn-system/index.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../../src/core/subagent/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { scanSubagentResults } from '../../src/cli/commands/subagent-helpers.js';
import { cleanupTempDir, createTrackedTempDir } from '../utils/temp.js';

class ReadFailureFileSystem extends NodeFileSystem {
  constructor(baseDir: string, private readonly blockedSuffix: string) {
    super({ baseDir });
  }

  override read(recordPath: string): Promise<string> {
    if (recordPath.endsWith(this.blockedSuffix)) {
      return Promise.reject(Object.assign(new Error('injected execution read failure'), { code: 'EACCES' }));
    }
    return super.read(recordPath);
  }
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result[child] = fs.readFileSync(path.join(root, child), 'utf8');
    }
  };
  visit('.');
  return result;
}

describe('Phase 2248 Step J CLI execution status', () => {
  let tempDir: string;
  let clawFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTrackedTempDir('chestnut-cli-execution-status-');
    clawFs = new NodeFileSystem({ baseDir: tempDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function createExecution(id: string, options: { resultDir?: string; input?: unknown } = {}) {
    const resultDir = options.resultDir ?? path.join(TASKS_SYNC_SPAWN_DIR, id);
    const location = { runId: id, resultDir };
    const store = createSubagentExecutionStore({
      fs: clawFs,
      resultDir,
      newAttemptId: () => `attempt-${id}`,
      now: () => 1_700_000_000_000,
    });
    const input = await store.prepareInput(location, options.input ?? { prompt: `prompt-${id}` });
    const claimed = await store.claimAttempt({
      location,
      inputDigest: input.document.inputDigest,
      ordinal: 1,
      parentAttemptId: null,
      startBasis: 'start',
    });
    if (claimed.kind !== 'claimed') throw new Error('expected a new execution claim');
    await claimed.writer.transition({ state: 'prepared' });
    await claimed.writer.transition({ state: 'running' });
    return { location, store, writer: claimed.writer };
  }

  async function scan() {
    return scanSubagentResults({ fsFactory: baseDir => new NodeFileSystem({ baseDir }) }, tempDir);
  }

  it.each([
    { state: 'running', sequence: 2 },
    { state: 'stopping', sequence: 3 },
    { state: 'settling', sequence: 3 },
    { state: 'recovery_required', sequence: 3 },
  ] as const)('reports real $state despite a stale result.txt', async ({ state, sequence }) => {
    const id = `spawn-${state}`;
    const { location, writer } = await createExecution(id);
    if (state !== 'running') await writer.transition({ state, reason: { kind: 'test' } });
    await clawFs.writeAtomic(path.join(location.resultDir, 'result.txt'), 'stale legacy result');

    const observation = await querySubagentExecution(clawFs, location);
    expect(observation).toMatchObject({ kind: 'found', view: { state, sequence } });
    const entries = await scan();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id,
      status: state,
      source: 'execution',
      state,
      sequence,
      identity: { runId: id, attemptId: `attempt-${id}`, resultDir: location.resultDir },
      degraded: [],
    });
    if (state !== 'running') expect(entries[0].reason).toEqual({ kind: 'test' });
  });

  it('projects a settled outcome and retains its persistence, degradation and original failure', async () => {
    const { location, writer } = await createExecution('spawn-settled');
    await writer.settle({
      kind: 'failed',
      content: 'real failure content',
      cause: { message: 'original failure', code: 'E_REAL' },
      recovery: 'uncertain_side_effect',
      degraded: [{ stage: 'artifact', artifact: 'artifact.txt', error: 'artifact write failed' }],
    });
    await clawFs.writeAtomic(path.join(location.resultDir, 'result.txt'), 'stale success text');

    const [entry] = await scan();
    expect(entry).toMatchObject({
      status: 'failed',
      source: 'execution',
      state: 'settled',
      sequence: 4,
      identity: location,
      persistence: {
        outcome: { persisted: true, durable: false, kind: 'unknown' },
      },
      degraded: [{ stage: 'artifact', error: 'artifact write failed' }],
      outcome: {
        kind: 'failed',
        content: 'real failure content',
        cause: { message: 'original failure', code: 'E_REAL' },
        recovery: 'uncertain_side_effect',
      },
    });
  });

  it('uses legacy inference only when execution metadata is absent', async () => {
    const resultDir = path.join(TASKS_SYNC_SPAWN_DIR, 'spawn-legacy');
    await clawFs.writeAtomic(path.join(resultDir, 'result.txt'), 'legacy result');

    const observation = await querySubagentExecution(clawFs, { runId: 'spawn-legacy', resultDir });
    expect(observation).toEqual({
      kind: 'legacy',
      runId: 'spawn-legacy',
      resultDir,
      artifacts: ['result.txt'],
    });
    const [entry] = await scan();
    expect(entry).toMatchObject({ status: 'completed', source: 'legacy' });
    expect(entry.identity).toBeUndefined();
    expect(entry.sequence).toBeUndefined();
  });

  it('reports corrupt execution records as error instead of missing or completed', async () => {
    const { location } = await createExecution('spawn-corrupt');
    const claimPath = path.join(location.resultDir, 'execution/attempts/1/claim.json');
    await clawFs.writeAtomic(claimPath, '{not-json');
    await clawFs.writeAtomic(path.join(location.resultDir, 'result.txt'), 'stale result');

    const observation = await querySubagentExecution(clawFs, location);
    expect(observation.kind).toBe('corrupt');
    const [entry] = await scan();
    expect(entry.status).toBe('error');
    expect(entry.source).toBe('execution');
    expect(entry.error?.reason).toContain('execution record corrupt');
    expect(entry.error?.path).toBe(claimPath);
  });

  it('preserves execution I/O failures as explicit errors', async () => {
    const { location } = await createExecution('spawn-io');
    await clawFs.writeAtomic(path.join(location.resultDir, 'result.txt'), 'stale result');
    const failingFs = new ReadFailureFileSystem(tempDir, 'execution/input.json');

    const observation = await querySubagentExecution(failingFs, location);
    expect(observation).toMatchObject({ kind: 'corrupt', reason: expect.stringContaining('unreadable') });
    const entries = await scanSubagentResults({
      fsFactory: baseDir => baseDir === tempDir
        ? new ReadFailureFileSystem(baseDir, 'execution/input.json')
        : new NodeFileSystem({ baseDir }),
    }, tempDir);
    expect(entries[0]).toMatchObject({ status: 'error', source: 'execution' });
    expect(entries[0].error?.reason).toContain('injected execution read failure');
  });

  it('does not write, start or resume while querying an in-flight execution', async () => {
    const state: Extract<SubagentExecutionState, 'stopping'> = 'stopping';
    const { location, writer } = await createExecution('spawn-read-only');
    await writer.transition({ state });
    const before = snapshot(tempDir);

    const first = await querySubagentExecution(clawFs, location);
    const second = await querySubagentExecution(clawFs, location);
    await scan();

    expect(first).toEqual(second);
    expect(snapshot(tempDir)).toEqual(before);
  });

  it('uses owner correlation for modern verifiers and never falls back to a misleading name', async () => {
    const attemptOnly = 'verifier-attempt-11111111-1111-1111-1111-111111111111';
    const misleading = 'verifier-contract-b-t1';
    const absent = 'verifier-contract-c-t2';
    const input = (currentContractId?: string) => ({
      schema_version: 1,
      kind: 'run_subagent_options',
      prompt: 'private prompt',
      ...(currentContractId !== undefined ? { currentContractId } : {}),
    });
    await createExecution(attemptOnly, {
      resultDir: path.join(TASKS_SYNC_SUBAGENT_DIR, attemptOnly),
      input: input('contract-a'),
    });
    await createExecution(misleading, {
      resultDir: path.join(TASKS_SYNC_SUBAGENT_DIR, misleading),
      input: input('contract-a'),
    });
    await createExecution(absent, {
      resultDir: path.join(TASKS_SYNC_SUBAGENT_DIR, absent),
      input: input(),
    });

    const entries = await scan();
    for (const id of [attemptOnly, misleading]) {
      expect(entries.find(e => e.id === id)).toMatchObject({
        status: 'running',
        contractId: 'contract-a',
        contractCorrelation: { kind: 'known', contractId: 'contract-a', source: 'execution_input' },
      });
    }
    expect(entries.find(e => e.id === absent)).toMatchObject({
      status: 'running',
      contractCorrelation: { kind: 'unknown', reason: 'execution input has no currentContractId' },
    });
    expect(entries.find(e => e.id === absent)?.contractId).toBeUndefined();
  });

  it('keeps a corrupt modern verifier association unknown without legacy-name recovery', async () => {
    const id = 'verifier-contract-a-t1';
    const { location } = await createExecution(id, {
      resultDir: path.join(TASKS_SYNC_SUBAGENT_DIR, id),
      input: { schema_version: 1, kind: 'run_subagent_options', currentContractId: 'contract-a' },
    });
    const inputPath = path.join(location.resultDir, 'execution/input.json');
    const document = JSON.parse(await clawFs.read(inputPath));
    document.runId = 'verifier-other';
    await clawFs.writeAtomic(inputPath, JSON.stringify(document));

    const [entry] = await scan();
    expect(entry).toMatchObject({
      id,
      status: 'error',
      source: 'execution',
      contractCorrelation: { kind: 'unknown' },
    });
    expect(entry.contractId).toBeUndefined();
  });
});
