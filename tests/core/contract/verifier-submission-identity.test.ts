/**
 * Phase 2249 Step C: accepted submissions own distinct real verifier executions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ContractSystem } from '../../../src/core/contract/manager.js';
import { subagentListCommand } from '../../../src/cli/commands/subagent-list.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import type { ContractId } from '../../../src/core/contract/types.js';
import {
  createDefaultSubagentExecutionRunner,
  prepareSubagentInput,
  querySubagentExecution,
  TASKS_SYNC_SUBAGENT_DIR,
  type SubagentExecutionLocation,
} from '../../../src/core/subagent/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { getClawDir } from '../../../src/foundation/claw-identity/index.js';
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
import { SUBAGENT_WAIT_TIMEOUT_MS } from '../../helpers/test-timeouts.js';
import { cleanupTempDir, createTrackedTempDir } from '../../utils/temp.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function textChunks(text: string): LLMStreamChunk[] {
  return [
    { type: 'text_delta', delta: text },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ];
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

async function queryFound(fs: NodeFileSystem, location: SubagentExecutionLocation) {
  const observation = await querySubagentExecution(fs, location);
  if (observation.kind !== 'found') {
    throw new Error(`expected execution at ${location.resultDir}, got ${observation.kind}`);
  }
  return observation;
}

const tempDirs: string[] = [];
const managers: ContractSystem[] = [];
const gates: Array<ReturnType<typeof gatedTool>> = [];
let savedChestnutRoot: string | undefined;

afterEach(async () => {
  for (const gate of gates.splice(0)) {
    gate.release({ success: false, content: 'released by afterEach cleanup' });
  }
  try {
    await Promise.all(managers.splice(0).map(manager => manager.close()));
  } finally {
    if (savedChestnutRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = savedChestnutRoot;
    await Promise.all(tempDirs.splice(0).map(cleanupTempDir));
  }
});

async function fixture(tag: string, scripts: readonly (readonly LLMStreamChunk[])[], gate?: ReturnType<typeof gatedTool>) {
  const root = await createTrackedTempDir(`chestnut-phase2249-identity-${tag}-`);
  tempDirs.push(root);
  savedChestnutRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = root;
  const clawDir = getClawDir('phase2249-claw');
  await fsp.mkdir(clawDir, { recursive: true });
  const fs = new NodeFileSystem({ baseDir: clawDir });
  const registry = new ToolRegistryImpl();
  if (gate) registry.register(gate.tool);
  const controlled = fakeLlm(scripts);
  const auditFixture = makeAudit();
  const manager = new ContractSystem({
    clawDir,
    clawId: 'phase2249-claw',
    fs,
    audit: auditFixture.audit,
    llm: controlled.llm,
    toolRegistry: registry,
    fsFactory: baseDir => new NodeFileSystem({ baseDir }),
    deliverCancellation: async () => {},
    notifyClaw: vi.fn(),
    // 不注入 runVerifier/runContractVerifier：提交必须走真实默认执行链。
  });
  managers.push(manager);
  const contractId = await manager.create(makeContractYaml({
    id: `phase2249-identity-${tag}`,
    title: 'Verifier submission identity',
    goal: 'Bind each accepted submission to its own verifier execution',
    subtasks: [
      { id: 't1', description: 'verified subtask' },
      { id: 't2', description: 'keeps the contract active' },
    ],
    verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
    verification_attempts: 3,
  }));
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
  return { clawDir, fs, controlled, manager, contractId, ctx, ...auditFixture };
}

async function currentExecution(manager: ContractSystem, contractId: ContractId) {
  const progress = await manager.getProgress(contractId);
  const attemptId = progress?.subtasks.t1.verification_attempt_id;
  if (!attemptId) throw new Error('submission did not persist its verification attempt id');
  const compactAttemptId = attemptId.replaceAll('-', '');
  return { attemptId, location: executionLocation(`verifier-${contractId}-${compactAttemptId}`), progress };
}

async function submitAndWait(
  f: Awaited<ReturnType<typeof fixture>>,
  evidence: string,
) {
  const backgroundDone = waitForNextAuditEvent(
    f.emitter,
    CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
  );
  await expect(f.manager.createSubmitSubtaskTool().execute({
    subtask: 't1', evidence,
  }, f.ctx)).resolves.toMatchObject({ success: true, metadata: { async: true } });
  await backgroundDone;
}

describe('Phase 2249 Step C verifier submission identity', () => {
  it('V01/V02: a same-evidence resubmission gets a new attempt, directory and verdict', async () => {
    const firstText = JSON.stringify({ passed: false, reason: 'first rejection' });
    const secondText = JSON.stringify({ passed: true, reason: 'second acceptance' });
    const f = await fixture('same-evidence', [textChunks(firstText), textChunks(secondText)]);

    await submitAndWait(f, 'same evidence');
    const first = await currentExecution(f.manager, f.contractId);
    expect(first.progress?.subtasks.t1).toMatchObject({
      status: 'todo', retry_count: 1, verification_attempt_id: first.attemptId,
    });
    expect((await queryFound(f.fs, first.location)).view).toMatchObject({
      state: 'settled',
      outcome: { kind: 'completed', rawResult: { text: firstText } },
    });
    const firstInput = await f.fs.read(`${first.location.resultDir}/execution/input.json`);
    const firstOutcome = await f.fs.read(`${first.location.resultDir}/execution/attempts/1/outcome.json`);

    await submitAndWait(f, 'same evidence');
    const second = await currentExecution(f.manager, f.contractId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.location).not.toEqual(first.location);
    expect(second.progress?.subtasks.t1).toMatchObject({
      status: 'completed', verification_attempt_id: second.attemptId,
    });
    expect((await queryFound(f.fs, second.location)).view).toMatchObject({
      state: 'settled',
      outcome: { kind: 'completed', rawResult: { text: secondText } },
    });
    expect(f.controlled.calls()).toBe(2);
    expect(await f.fs.read(`${first.location.resultDir}/execution/input.json`)).toBe(firstInput);
    expect(await f.fs.read(`${first.location.resultDir}/execution/attempts/1/outcome.json`)).toBe(firstOutcome);
    expect(JSON.parse(firstInput).input.currentContractId).toBe(f.contractId);
    expect((await queryFound(f.fs, first.location)).correlation).toEqual({
      kind: 'known', currentContractId: f.contractId,
    });
    expect((await queryFound(f.fs, second.location)).correlation).toEqual({
      kind: 'known', currentContractId: f.contractId,
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await subagentListCommand({
        fsFactory: baseDir => new NodeFileSystem({ baseDir }),
      }, { claw: 'phase2249-claw', contract: f.contractId, json: true });
      const filtered = JSON.parse(consoleLog.mock.calls[0][0]);
      expect(filtered.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: first.location.runId,
          contract_id: f.contractId,
          contract_correlation: { kind: 'known', source: 'execution_input' },
        }),
        expect.objectContaining({
          id: second.location.runId,
          contract_id: f.contractId,
          contract_correlation: { kind: 'known', source: 'execution_input' },
        }),
      ]));
      expect(filtered.entries).toHaveLength(2);
      expect(filtered.incomplete).toBe(false);

      consoleLog.mockClear();
      await subagentListCommand({
        fsFactory: baseDir => new NodeFileSystem({ baseDir }),
      }, { claw: 'phase2249-claw', contract: 'contract-other', json: true });
      const excluded = JSON.parse(consoleLog.mock.calls[0][0]);
      expect(excluded.entries).toEqual([]);
      expect(excluded.incomplete).toBe(false);

      consoleLog.mockClear();
      await subagentListCommand({
        fsFactory: baseDir => new NodeFileSystem({ baseDir }),
      }, { claw: 'phase2249-claw', contract: f.contractId });
      const text = consoleLog.mock.calls.flat().join('\n');
      expect(text).toContain('Total: 2 entries');
      expect(text).not.toContain('contract-filtered results may be incomplete');
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('V03: changed evidence starts an independent execution without an input conflict', async () => {
    const firstText = JSON.stringify({ passed: false, reason: 'first evidence rejected' });
    const secondText = JSON.stringify({ passed: false, reason: 'second evidence rejected' });
    const f = await fixture('changed-evidence', [textChunks(firstText), textChunks(secondText)]);

    await submitAndWait(f, 'first evidence');
    const first = await currentExecution(f.manager, f.contractId);
    const firstInput = await f.fs.read(`${first.location.resultDir}/execution/input.json`);
    const firstOutcome = await f.fs.read(`${first.location.resultDir}/execution/attempts/1/outcome.json`);

    await submitAndWait(f, 'second evidence with new facts');
    const second = await currentExecution(f.manager, f.contractId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.location.resultDir).not.toBe(first.location.resultDir);
    expect((await queryFound(f.fs, second.location)).view.outcome).toMatchObject({
      kind: 'completed', rawResult: { text: secondText },
    });
    expect(await f.fs.read(`${second.location.resultDir}/execution/input.json`)).toContain('second evidence with new facts');
    expect(f.controlled.calls()).toBe(2);
    expect(await f.fs.read(`${first.location.resultDir}/execution/input.json`)).toBe(firstInput);
    expect(await f.fs.read(`${first.location.resultDir}/execution/attempts/1/outcome.json`)).toBe(firstOutcome);
  });

  it('V04: an in-progress duplicate submission creates neither another LLM call nor directory', async () => {
    const gate = gatedTool('identity_gate');
    gates.push(gate);
    const verdict = JSON.stringify({ passed: false, reason: 'gated rejection' });
    const f = await fixture('duplicate', [
      toolChunks(gate.tool.name),
      toolChunks('done', { result: verdict }),
    ], gate);

    await expect(f.manager.createSubmitSubtaskTool().execute({
      subtask: 't1', evidence: 'held evidence',
    }, f.ctx)).resolves.toMatchObject({ success: true, metadata: { async: true } });
    await gate.entered;
    const current = await currentExecution(f.manager, f.contractId);

    await expect(f.manager.createSubmitSubtaskTool().execute({
      subtask: 't1', evidence: 'duplicate while gated',
    }, f.ctx)).rejects.toThrow('Cannot start verification');
    expect(f.controlled.calls()).toBe(1);
    expect(gate.execute).toHaveBeenCalledTimes(1);
    const runDirs = await fsp.readdir(path.join(f.clawDir, TASKS_SYNC_SUBAGENT_DIR));
    expect(runDirs.filter(name => name.startsWith(`verifier-${f.contractId}-`))).toEqual([current.location.runId]);

    const backgroundDone = waitForNextAuditEvent(
      f.emitter,
      CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    );
    gate.release({ success: true, content: 'gate completed' });
    await backgroundDone;
    expect(f.controlled.calls()).toBe(2);
    expect(gate.execute).toHaveBeenCalledTimes(1);
    expect((await queryFound(f.fs, current.location)).view.state).toBe('settled');
  });

  it('V05/V06: reconnecting one frozen execution is idempotent and changed input still conflicts', async () => {
    const root = await createTrackedTempDir('chestnut-phase2249-reconnect-');
    tempDirs.push(root);
    const fs = new NodeFileSystem({ baseDir: root });
    const registry = new ToolRegistryImpl();
    const controlled = fakeLlm([textChunks('completed once')]);
    const runner = createDefaultSubagentExecutionRunner({
      clawDir: root,
      syncDir: path.join(root, 'tasks/sync'),
      fs,
      llm: controlled.llm,
      registry,
    });
    const input = prepareSubagentInput({
      prompt: 'frozen verifier input',
      tools: { manifest: registry.freeze() },
      budget: { timeoutMs: SUBAGENT_WAIT_TIMEOUT_MS, maxSteps: 1 },
    });
    const location = executionLocation('verifier-attempt-reconnect');
    const first = await runner.start({ ...location, input });
    await expect(first.completion).resolves.toMatchObject({ kind: 'completed', content: 'completed once' });
    const originalInput = await fs.read(`${location.resultDir}/execution/input.json`);

    const reconnected = await runner.start({ ...location, input });
    expect(reconnected.identity).toEqual(first.identity);
    await expect(reconnected.completion).resolves.toMatchObject({ content: 'completed once' });
    const opened = await runner.open(location);
    expect(opened).toMatchObject({ kind: 'found', owner: 'settled' });
    if (opened.kind === 'found') expect(opened.ref.identity).toEqual(first.identity);
    expect(controlled.calls()).toBe(1);

    const changed = prepareSubagentInput({
      prompt: 'different input for the same identity',
      tools: { manifest: registry.freeze() },
      budget: { timeoutMs: SUBAGENT_WAIT_TIMEOUT_MS, maxSteps: 1 },
    });
    await expect(runner.start({ ...location, input: changed })).rejects.toMatchObject({ kind: 'conflict' });
    expect(controlled.calls()).toBe(1);
    expect(await fs.read(`${location.resultDir}/execution/input.json`)).toBe(originalInput);
    expect((await queryFound(fs, location)).view.outcome).toMatchObject({ content: 'completed once' });
  });
});
