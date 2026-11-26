/**
 * Phase 2249 Step C/F: legacy verifier result directories stay isolated from new submissions.
 *
 * Contract 自有旧 verification outcome / boot replay 已由 verification-outcome-recovery.test.ts
 * 覆盖；本文件不重复伪造 Contract outcome 私有记录。Step F 另以真实默认 verifier 执行链
 * 生成 attempt-only 历史，验证三个命名代际的 owner/CLI 关联与只读兼容性。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { makeContractId } from '../../../src/core/contract/types.js';
import { runContractVerifier } from '../../../src/core/contract/verifier-job.js';
import { subagentListCommand } from '../../../src/cli/commands/subagent-list.js';
import { scanSubagentResults } from '../../../src/cli/commands/subagent-helpers.js';
import {
  createSubagentExecutionStore,
  querySubagentExecution,
  TASKS_SYNC_SUBAGENT_DIR,
  type SubagentExecutionLocation,
  type SubagentSettlementInput,
} from '../../../src/core/subagent/index.js';
import { getClawDir } from '../../../src/foundation/claw-identity/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type {
  LLMCallOptions,
  LLMOrchestrator,
  LLMStreamChunk,
} from '../../../src/foundation/llm-orchestrator/index.js';
import type { Tool } from '../../../src/foundation/tools/index.js';
import type { ToolResult } from '../../../src/foundation/tool-protocol/index.js';
import { ToolRegistryImpl } from '../../../src/foundation/tools/registry.js';
import { makeAudit, waitForNextAuditEvent } from '../../helpers/audit.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { makeExecContext } from '../../helpers/exec-context.js';
import { waitFor } from '../../helpers/wait-for.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function toolChunks(name: string, input: Record<string, unknown> = {}): LLMStreamChunk[] {
  return [
    { type: 'tool_use_start', toolUse: { id: `toolu_${name}`, name, partialInput: '' } },
    { type: 'tool_use_delta', toolUse: { id: '', name: '', partialInput: JSON.stringify(input) } },
    { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

function fakeLlm(scripts: readonly (readonly LLMStreamChunk[])[]) {
  let calls = 0;
  const stream = vi.fn((_options: LLMCallOptions): AsyncIterableIterator<LLMStreamChunk> => {
    const script = scripts[calls++];
    if (!script) throw new Error(`controlled LLM has no response for call ${calls}`);
    return (async function* () {
      for (const chunk of script) yield chunk;
    })();
  });
  const llm = {
    stream,
    call: vi.fn(),
    healthCheck: vi.fn(async () => true),
    getProviderInfo: vi.fn(() => ({ name: 'controlled', model: 'controlled', isFallback: false })),
    getFailureDisposition: vi.fn(() => 'unknown' as const),
    close: vi.fn(async () => {}),
    reloadConfig: vi.fn(),
  } as unknown as LLMOrchestrator;
  return { llm, calls: () => calls };
}

function gatedTool(name: string) {
  const entered = deferred();
  const release = deferred<ToolResult>();
  const tool: Tool = {
    name,
    description: 'controlled readonly verifier execution gate',
    schema: { type: 'object', properties: {} },
    readonly: true,
    idempotent: true,
    profiles: ['readonly'],
    execute: vi.fn(() => {
      entered.resolve();
      return release.promise;
    }),
  };
  return { tool, entered: entered.promise, release: release.resolve, execute: tool.execute };
}

function executionLocation(runId: string): SubagentExecutionLocation {
  return { runId, resultDir: `${TASKS_SYNC_SUBAGENT_DIR}/${runId}` };
}

const CLAW_ID = 'phase2249-claw';
const nodeFsFactory = (baseDir: string): NodeFileSystem => new NodeFileSystem({ baseDir });

function rawVerdict(passed: boolean, reason: string) {
  return { text: '', capturedResult: { result: JSON.stringify({ passed, reason }) } };
}

async function seedLegacyExecution(
  fs: NodeFileSystem,
  location: SubagentExecutionLocation,
  options: { resultText: string; outcome?: SubagentSettlementInput },
) {
  const store = createSubagentExecutionStore({
    fs,
    resultDir: location.resultDir,
    newAttemptId: () => `legacy-attempt-${location.runId}`,
    now: () => 1_700_000_000_000,
  });
  const input = await store.prepareInput(location, { prompt: 'legacy verifier input' });
  const claimed = await store.claimAttempt({
    location,
    inputDigest: input.document.inputDigest,
    ordinal: 1,
    parentAttemptId: null,
    startBasis: 'start',
  });
  if (claimed.kind !== 'claimed') throw new Error('expected a new legacy execution claim');
  await claimed.writer.transition({ state: 'prepared' });
  await claimed.writer.transition({ state: 'running' });
  if (options.outcome) await claimed.writer.settle(options.outcome);
  await fs.writeAtomic(`${location.resultDir}/result.txt`, options.resultText);
  return { writer: claimed.writer };
}

async function queryFound(fs: NodeFileSystem, location: SubagentExecutionLocation) {
  const observation = await querySubagentExecution(fs, location);
  if (observation.kind !== 'found') {
    throw new Error(`expected execution at ${location.resultDir}, got ${observation.kind}`);
  }
  return observation;
}

async function hashFiles(root: string, relativeDir: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await fsp.readdir(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) {
        const bytes = await fsp.readFile(path.join(root, child));
        hashes[child.split(path.sep).join('/')] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  };
  await visit(relativeDir);
  return hashes;
}

const tempDirs: string[] = [];
const managers: ContractSystem[] = [];
const gates: Array<ReturnType<typeof gatedTool>> = [];
let originalChestnutRoot: string | undefined;
let chestnutRootOverridden = false;
let consoleLog: ReturnType<typeof vi.spyOn> | undefined;

afterEach(async () => {
  consoleLog?.mockRestore();
  consoleLog = undefined;
  if (chestnutRootOverridden) {
    if (originalChestnutRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalChestnutRoot;
    originalChestnutRoot = undefined;
    chestnutRootOverridden = false;
  }
  for (const gate of gates.splice(0)) {
    gate.release({ success: false, content: 'released by afterEach cleanup' });
  }
  try {
    await Promise.all(managers.splice(0).map(async manager => {
      await waitFor(() => manager.getActiveVerifierCount() === 0);
      await manager.close();
    }));
  } finally {
    await Promise.all(tempDirs.splice(0).map(cleanupTempDir));
  }
});

async function fixture(
  tag: string,
  verdict: { passed: boolean; reason: string },
  options: { realClawPath?: boolean } = {},
) {
  const root = await createTrackedTempDir(`chestnut-phase2249-${tag}-`);
  tempDirs.push(root);
  if (options.realClawPath) {
    originalChestnutRoot = process.env.CHESTNUT_ROOT;
    chestnutRootOverridden = true;
    process.env.CHESTNUT_ROOT = root;
  }
  const clawDir = options.realClawPath ? getClawDir(CLAW_ID) : path.join(root, 'claw');
  await fsp.mkdir(clawDir, { recursive: true });
  const fs = new NodeFileSystem({ baseDir: clawDir });
  const gate = gatedTool(`compat_gate_${tag}`);
  gates.push(gate);
  const registry = new ToolRegistryImpl();
  registry.register(gate.tool);
  const controlled = fakeLlm([
    toolChunks(gate.tool.name),
    toolChunks('done', { result: JSON.stringify(verdict) }),
  ]);
  const auditFixture = makeAudit();
  const manager = new ContractSystem({
    clawDir,
    clawId: CLAW_ID,
    fs,
    audit: auditFixture.audit,
    llm: controlled.llm,
    toolRegistry: registry,
    fsFactory: nodeFsFactory,
    deliverCancellation: async () => {},
    notifyClaw: vi.fn(),
    // 不注入 runVerifier/runContractVerifier：走真实 defaultRunVerifier/startSubagent。
  });
  managers.push(manager);
  const contractId = makeContractId(await manager.create(makeContractYaml({
    id: `phase2249-${tag}`,
    title: 'Verifier submission compatibility',
    goal: 'Keep legacy and current verifier executions independent',
    subtasks: [
      { id: 't1', description: 'verified subtask' },
      { id: 't2', description: 'keeps the contract active' },
    ],
    verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
    verification_attempts: 3,
  })));
  await fs.writeAtomic(
    `contract/active/${contractId}/verification/t1.prompt.txt`,
    'Verify {{subtask_description}}: {{evidence}}',
  );
  const ctx = makeExecContext({
    clawDir,
    workspaceDir: path.join(clawDir, 'clawspace'),
    syncDir: path.join(clawDir, 'tasks/sync'),
    fs,
    llm: controlled.llm,
    registry,
  });
  return { clawDir, fs, gate, controlled, manager, contractId, ctx, ...auditFixture };
}

async function currentExecution(manager: ContractSystem, contractId: ReturnType<typeof makeContractId>) {
  const progress = await manager.getProgress(contractId);
  const attemptId = progress?.subtasks.t1.verification_attempt_id;
  if (!attemptId) throw new Error('submission did not persist its verification attempt id');
  const agentId = `verifier-${contractId}-${attemptId.replaceAll('-', '')}`;
  return { attemptId, location: executionLocation(agentId) };
}

describe('Phase 2249 Step C/F verifier submission compatibility', () => {
  it('does not reuse a settled legacy verdict and preserves every legacy byte', async () => {
    const currentVerdict = { passed: true, reason: 'current independent pass' };
    const f = await fixture('settled', currentVerdict);
    const legacyLocation = executionLocation(`verifier-${f.contractId}-t1`);
    const legacyReason = 'legacy settled rejection';
    await seedLegacyExecution(f.fs, legacyLocation, {
      resultText: 'legacy result bytes\n旧记录不得改变\n',
      outcome: {
        kind: 'completed',
        content: 'legacy settled verifier',
        rawResult: rawVerdict(false, legacyReason),
      },
    });
    const legacyResultPath = path.join(f.clawDir, legacyLocation.resultDir, 'result.txt');
    const originalResultBytes = await fsp.readFile(legacyResultPath);
    const originalHashes = await hashFiles(f.clawDir, legacyLocation.resultDir);

    await expect(f.manager.createSubmitSubtaskTool().execute({
      subtask: 't1', evidence: 'new work requires a new verdict',
    }, f.ctx)).resolves.toMatchObject({
      success: true,
      metadata: { contractId: f.contractId, subtaskId: 't1', async: true },
    });
    await f.gate.entered;

    const current = await currentExecution(f.manager, f.contractId);
    expect(current.location.runId).toBe(
      `verifier-${f.contractId}-${current.attemptId.replaceAll('-', '')}`,
    );
    expect(current.location).not.toEqual(legacyLocation);
    expect((await queryFound(f.fs, legacyLocation)).view).toMatchObject({
      state: 'settled',
      outcome: { rawResult: rawVerdict(false, legacyReason) },
    });
    expect((await queryFound(f.fs, current.location)).view.state).toBe('running');
    expect((await queryFound(f.fs, current.location)).view.outcome).toBeUndefined();

    const backgroundDone = waitForNextAuditEvent(
      f.emitter,
      CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    );
    f.gate.release({ success: true, content: 'current readonly gate settled' });
    await backgroundDone;

    const currentSettled = await queryFound(f.fs, current.location);
    expect(currentSettled.view).toMatchObject({
      state: 'settled',
      outcome: { kind: 'completed', rawResult: rawVerdict(true, currentVerdict.reason) },
    });
    expect((await f.manager.getProgress(f.contractId))?.subtasks.t1).toMatchObject({
      status: 'completed', verification_attempt_id: current.attemptId,
    });
    expect((await queryFound(f.fs, legacyLocation)).view.outcome).toMatchObject({
      rawResult: rawVerdict(false, legacyReason),
    });
    expect(await fsp.readFile(legacyResultPath)).toEqual(originalResultBytes);
    expect(await hashFiles(f.clawDir, legacyLocation.resultDir)).toEqual(originalHashes);
    expect(f.controlled.calls()).toBe(2);
    expect(f.gate.execute).toHaveBeenCalledTimes(1);
  });

  it('ignores a late outcome from the running legacy execution while the current execution is gated', async () => {
    const currentVerdict = { passed: false, reason: 'current independent rejection' };
    const f = await fixture('late', currentVerdict);
    const legacyLocation = executionLocation(`verifier-${f.contractId}-t1`);
    const legacy = await seedLegacyExecution(f.fs, legacyLocation, {
      resultText: 'legacy execution is still running',
    });

    await expect(f.manager.createSubmitSubtaskTool().execute({
      subtask: 't1', evidence: 'current work is held at its own readonly gate',
    }, f.ctx)).resolves.toMatchObject({ success: true, metadata: { async: true } });
    await f.gate.entered;

    const current = await currentExecution(f.manager, f.contractId);
    expect(current.location).not.toEqual(legacyLocation);
    expect((await queryFound(f.fs, legacyLocation)).view.state).toBe('running');
    expect((await queryFound(f.fs, current.location)).view.state).toBe('running');

    const lateLegacyReason = 'late legacy pass must not win';
    await legacy.writer.settle({
      kind: 'completed',
      content: 'late legacy verifier outcome',
      rawResult: rawVerdict(true, lateLegacyReason),
    });
    await f.fs.writeAtomic(`${legacyLocation.resultDir}/result.txt`, 'late legacy result text');
    const lateHashes = await hashFiles(f.clawDir, legacyLocation.resultDir);

    expect((await queryFound(f.fs, legacyLocation)).view).toMatchObject({
      state: 'settled',
      outcome: { rawResult: rawVerdict(true, lateLegacyReason) },
    });
    expect((await queryFound(f.fs, current.location)).view.state).toBe('running');
    expect((await queryFound(f.fs, current.location)).view.outcome).toBeUndefined();
    expect((await f.manager.getProgress(f.contractId))?.subtasks.t1).toMatchObject({
      status: 'in_progress', verification_attempt_id: current.attemptId,
    });

    const backgroundDone = waitForNextAuditEvent(
      f.emitter,
      CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    );
    f.gate.release({ success: true, content: 'current gate released after legacy settlement' });
    await backgroundDone;

    expect((await queryFound(f.fs, current.location)).view).toMatchObject({
      state: 'settled',
      outcome: { kind: 'completed', rawResult: rawVerdict(false, currentVerdict.reason) },
    });
    const finalSubtask = (await f.manager.getProgress(f.contractId))?.subtasks.t1;
    expect(finalSubtask).toMatchObject({
      status: 'todo',
      retry_count: 1,
      verification_attempt_id: current.attemptId,
      last_failed_feedback: { cause: 'llm_rejected' },
    });
    expect(finalSubtask?.last_failed_feedback?.feedback).toContain(currentVerdict.reason);
    expect((await queryFound(f.fs, legacyLocation)).view.outcome).toMatchObject({
      rawResult: rawVerdict(true, lateLegacyReason),
    });
    expect(await hashFiles(f.clawDir, legacyLocation.resultDir)).toEqual(lateHashes);
    expect(f.controlled.calls()).toBe(2);
    expect(f.gate.execute).toHaveBeenCalledTimes(1);
  });

  it('correlates real attempt-only history beside fixed-name and compact-name generations without rewriting it', async () => {
    const currentVerdict = { passed: true, reason: 'current compact-name pass' };
    const f = await fixture('generations', currentVerdict, { realClawPath: true });
    expect(f.clawDir).toBe(getClawDir(CLAW_ID));

    // 真正的旧固定名只有历史 result，不带可伪造归属的现代 execution input。
    const legacyLocation = executionLocation(`verifier-${f.contractId}-t1`);
    const legacyResult = 'fixed-name legacy result bytes\n旧记录不得改变\n';
    await f.fs.writeAtomic(`${legacyLocation.resultDir}/result.txt`, legacyResult);
    const legacyResultPath = path.join(f.clawDir, legacyLocation.resultDir, 'result.txt');
    const originalLegacyBytes = await fsp.readFile(legacyResultPath);
    await expect(querySubagentExecution(f.fs, legacyLocation)).resolves.toMatchObject({ kind: 'legacy' });

    // F 之前的 attempt-only 记录也必须由真实默认执行链产生，不能用 prepareInput 拼 fixture。
    const historicalAttemptId = '10000000-0000-4000-8000-000000000001';
    const historicalAgentId = `verifier-attempt-${historicalAttemptId}`;
    const historicalLocation = executionLocation(historicalAgentId);
    const historicalVerdict = { passed: false, reason: 'persisted attempt-only rejection' };
    const historicalLlm = fakeLlm([
      toolChunks('done', { result: JSON.stringify(historicalVerdict) }),
    ]);
    await expect(runContractVerifier({
      agentId: historicalAgentId,
      clawId: CLAW_ID,
      clawDir: f.clawDir,
      contractId: f.contractId,
      fs: f.fs,
      llm: historicalLlm.llm,
      audit: f.audit,
      prompt: 'verify the historical attempt through the real default runner',
      toolRegistry: new ToolRegistryImpl(),
      fsFactory: nodeFsFactory,
      // 不注入 runVerifier：必须经默认 startSubagent 持久化真实 execution input。
    })).resolves.toMatchObject({
      passed: false,
      structured: historicalVerdict,
    });
    expect(historicalLlm.calls()).toBe(1);

    const historicalInput = JSON.parse(
      await f.fs.read(`${historicalLocation.resultDir}/execution/input.json`),
    ) as Record<string, unknown>;
    expect(historicalInput).toMatchObject({
      input: {
        agentId: historicalAgentId,
        currentContractId: f.contractId,
        resultDir: historicalLocation.resultDir,
      },
    });
    expect((await queryFound(f.fs, historicalLocation))).toMatchObject({
      correlation: { kind: 'known', currentContractId: f.contractId },
      view: { state: 'settled', outcome: { rawResult: rawVerdict(false, historicalVerdict.reason) } },
    });
    const originalLegacyHashes = await hashFiles(f.clawDir, legacyLocation.resultDir);
    const originalHistoricalHashes = await hashFiles(f.clawDir, historicalLocation.resultDir);

    await expect(f.manager.createSubmitSubtaskTool().execute({
      subtask: 't1', evidence: 'new compact-name work remains independent',
    }, f.ctx)).resolves.toMatchObject({ success: true, metadata: { async: true } });
    await f.gate.entered;
    const current = await currentExecution(f.manager, f.contractId);
    expect(current.location.runId).toBe(
      `verifier-${f.contractId}-${current.attemptId.replaceAll('-', '')}`,
    );
    expect(new Set([legacyLocation.runId, historicalLocation.runId, current.location.runId]).size).toBe(3);
    expect((await queryFound(f.fs, current.location))).toMatchObject({
      correlation: { kind: 'known', currentContractId: f.contractId },
      view: { state: 'running' },
    });

    const backgroundDone = waitForNextAuditEvent(
      f.emitter,
      CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    );
    f.gate.release({ success: true, content: 'current compact-name gate settled' });
    await backgroundDone;

    const scanned = await scanSubagentResults({ fsFactory: nodeFsFactory }, f.clawDir);
    const expectedIds = [legacyLocation.runId, historicalLocation.runId, current.location.runId];
    expect(scanned.filter(entry => entry.kind === 'verifier').map(entry => entry.id).sort())
      .toEqual([...expectedIds].sort());
    expect(scanned.find(entry => entry.id === legacyLocation.runId)).toMatchObject({
      source: 'legacy',
      contractId: f.contractId,
      contractCorrelation: { kind: 'known', source: 'legacy_name' },
    });
    for (const runId of [historicalLocation.runId, current.location.runId]) {
      expect(scanned.find(entry => entry.id === runId)).toMatchObject({
        source: 'execution',
        contractId: f.contractId,
        contractCorrelation: { kind: 'known', source: 'execution_input' },
      });
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleLog = logSpy;
    interface ListPayload {
      entries: Array<{
        id: string;
        contract_id: string | null;
        contract_correlation: { kind: string; source?: string } | null;
      }>;
      total: number;
      incomplete: boolean;
      correlation_issues: unknown[];
    }
    const listJson = async (contract?: string): Promise<ListPayload> => {
      logSpy.mockClear();
      await subagentListCommand(
        { fsFactory: nodeFsFactory },
        { claw: CLAW_ID, json: true, ...(contract === undefined ? {} : { contract }) },
      );
      expect(logSpy).toHaveBeenCalledTimes(1);
      return JSON.parse(String(logSpy.mock.calls[0][0])) as ListPayload;
    };

    const ordinary = await listJson();
    expect(ordinary.total).toBe(3);
    expect(ordinary.entries.map(entry => entry.id).sort()).toEqual([...expectedIds].sort());
    for (const entry of ordinary.entries) {
      expect(entry.contract_id).toBe(f.contractId);
      expect(entry.contract_correlation).toMatchObject({
        kind: 'known',
        source: entry.id === legacyLocation.runId ? 'legacy_name' : 'execution_input',
      });
    }

    const filtered = await listJson(f.contractId);
    expect(filtered.entries.map(entry => entry.id).sort()).toEqual([...expectedIds].sort());
    expect(filtered.total).toBe(3);
    expect(filtered.incomplete).toBe(false);
    expect(filtered.correlation_issues).toEqual([]);
    const excluded = await listJson(makeContractId('phase2249-other-contract'));
    expect(excluded.entries).toEqual([]);
    expect(excluded.total).toBe(0);
    expect(excluded.incomplete).toBe(false);

    expect(await fsp.readFile(legacyResultPath)).toEqual(originalLegacyBytes);
    expect(await hashFiles(f.clawDir, legacyLocation.resultDir)).toEqual(originalLegacyHashes);
    expect(await hashFiles(f.clawDir, historicalLocation.resultDir)).toEqual(originalHistoricalHashes);
    expect(f.controlled.calls()).toBe(2);
    expect(f.gate.execute).toHaveBeenCalledTimes(1);
  });
});
