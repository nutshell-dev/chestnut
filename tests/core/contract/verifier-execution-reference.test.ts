/**
 * Phase 2248 H3: Contract consumes the real SubAgent execution reference.
 * Stop/cancel receipts never settle or unregister an actively running verifier.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ContractSystem } from '../../../src/core/contract/manager.js';
import { runContractVerifier } from '../../../src/core/contract/verifier-job.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import {
  makeContractId,
  makeSubtaskId,
  type VerifierConfig,
  type VerifierExecutionRef,
  type VerifierResult,
} from '../../../src/core/contract/types.js';
import type {
  SubagentExecutionIdentity,
  SubagentFinalOutcome,
} from '../../../src/core/subagent/index.js';
import { ToolTimeoutError } from '../../../src/foundation/tools/index.js';
import { createToolRegistry } from '../../../src/foundation/tools/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit, makeMockAudit, waitForNextAuditEvent } from '../../helpers/audit.js';
import { makeContractYaml } from '../../helpers/contract-yaml.js';
import { completeSubtask } from '../../helpers/contract-subtask.js';
import { waitFor } from '../../helpers/wait-for.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

const identity: SubagentExecutionIdentity = {
  runId: 'verifier-contract-h3-t1',
  attemptId: 'attempt-h3',
  resultDir: 'tasks/sync/subagent/verifier-contract-h3-t1',
};

function makeOutcome(
  kind: SubagentFinalOutcome['kind'],
  overrides: Partial<SubagentFinalOutcome> = {},
): SubagentFinalOutcome {
  return {
    identity,
    kind,
    content: kind,
    recovery: 'none',
    artifacts: [],
    degraded: [],
    persistence: {
      executionDir: `${identity.resultDir}/execution`,
      outcome: {
        path: `${identity.resultDir}/execution/attempts/1/outcome.json`,
        kind: 'durable',
        persisted: true,
        durable: true,
      },
      events: [],
      stops: [],
    },
    ...overrides,
  };
}

function makeExecution(completion: Promise<SubagentFinalOutcome>): VerifierExecutionRef {
  return { identity, completion };
}

function makeConfig(runVerifier?: VerifierConfig['runVerifier']): VerifierConfig {
  return {
    agentId: identity.runId,
    clawId: 'claw-h3',
    clawDir: '/tmp/claw-h3',
    contractId: makeContractId('contract-h3'),
    fs: {
      read: vi.fn().mockResolvedValue(JSON.stringify({
        schema_version: 1,
        subtasks: { t1: { status: 'todo' } },
      })),
    } as unknown as VerifierConfig['fs'],
    llm: {} as unknown as VerifierConfig['llm'],
    audit: makeMockAudit() as unknown as VerifierConfig['audit'],
    prompt: 'verify',
    toolRegistry: {
      getForProfile: vi.fn().mockReturnValue([]),
    } as unknown as VerifierConfig['toolRegistry'],
    fsFactory: vi.fn(() => ({}) as unknown as VerifierConfig['fs']),
    runVerifier,
  };
}

describe('default verifier execution reference consumption', () => {
  it('attaches a verifier reference and waits for its real completion', async () => {
    let resolveCompletion!: (outcome: SubagentFinalOutcome) => void;
    const completion = new Promise<SubagentFinalOutcome>(resolve => { resolveCompletion = resolve; });
    const execution = makeExecution(completion);
    const attach = vi.fn();
    let settled = false;

    const pending = runContractVerifier(makeConfig(async () => execution), { attach }).then(result => {
      settled = true;
      return result;
    });
    await waitFor(() => attach.mock.calls.length === 1);

    // The default mapping remains statically locked here; Step K exercises that
    // public entry with the real owner and gated Tools without module mocking.
    const source = await fs.readFile(path.join(process.cwd(), 'src/core/contract/verifier-job.ts'), 'utf8');
    expect(source).toContain('return startSubagent({');
    expect(attach).toHaveBeenCalledWith(execution);
    expect(settled).toBe(false);

    const outcome = makeOutcome('completed', {
      rawResult: { text: '', capturedResult: { passed: true, reason: 'ok' } },
    });
    resolveCompletion(outcome);

    await expect(pending).resolves.toMatchObject({
      passed: true,
      structured: { passed: true, reason: 'ok' },
    });
  });

  it('keeps a failed outcome cause instead of manufacturing passed:false', async () => {
    const cause = new Error('executor failed');
    const execution = makeExecution(Promise.resolve(makeOutcome('failed', { cause })));

    await expect(runContractVerifier(makeConfig(async () => execution))).rejects.toBe(cause);
  });

  it('keeps interrupted causes and artifact degradation separate from a verdict', async () => {
    // time-fixture: typed interruption payload, not an independent wait budget.
    const cause = new ToolTimeoutError('idle timeout', { timeoutMs: 100 });
    const interrupted = makeExecution(Promise.resolve(makeOutcome('interrupted', { cause })));
    const interruption = await runContractVerifier(makeConfig(async () => interrupted)).catch(error => error as Error);

    expect(interruption).toMatchObject({ name: 'AbortError', cause });

    const degradedOutcome = makeOutcome('completed', {
      rawResult: { text: '', capturedResult: { passed: true, reason: 'not authoritative' } },
      degraded: [{ stage: 'artifact', artifact: 'dialog:final_save', error: 'disk full' }],
    });
    const degraded = makeExecution(Promise.resolve(degradedOutcome));
    const artifactError = await runContractVerifier(makeConfig(async () => degraded)).catch(error => error as Error);

    expect(artifactError).toMatchObject({ name: 'VerifierArtifactError', outcome: degradedOutcome });
  });
});

type ManagerInternals = {
  runLLMVerification(
    promptFile: string,
    contractAbsDir: string,
    contractId: ReturnType<typeof makeContractId>,
    subtaskId: ReturnType<typeof makeSubtaskId>,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
    verificationAttemptId: string,
  ): Promise<VerifierResult>;
  _activeContractControllers: Map<string, Set<{
    promise: Promise<unknown>;
    identity?: SubagentExecutionIdentity;
  }>>;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupTempDir));
});

async function makeManager(runVerifier: VerifierConfig['runVerifier']) {
  const tempDir = await createTempDir();
  tempDirs.push(tempDir);
  const clawDir = path.join(tempDir, 'claws', 'test-claw');
  await fs.mkdir(clawDir, { recursive: true });
  const nodeFs = new NodeFileSystem({ baseDir: clawDir });
  const auditFixture = makeAudit();
  const manager = new ContractSystem({
    clawDir,
    clawId: 'test-claw',
    fs: nodeFs,
    audit: auditFixture.audit,
    llm: {} as unknown as VerifierConfig['llm'],
    toolRegistry: createToolRegistry(),
    fsFactory: (baseDir: string) => new NodeFileSystem({ baseDir }),
    runVerifier,
    deliverCancellation: async () => {},
    notifyClaw: vi.fn(),
  });
  return { manager, clawDir, ...auditFixture };
}

async function createVerifiedContract(manager: ContractSystem, clawDir: string) {
  const contractId = await manager.create(makeContractYaml({
    title: 'Execution reference',
    goal: 'Verify only after actual completion',
    subtasks: [{ id: 't1', description: 'T1' }],
    verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
  }));
  const verificationDir = path.join(clawDir, 'contract', 'active', contractId, 'verification');
  await fs.mkdir(verificationDir, { recursive: true });
  await fs.writeFile(path.join(verificationDir, 't1.prompt.txt'), 'Check: {{evidence}}');
  return contractId;
}

describe('ContractSystem verifier control lifetime', () => {
  it('keeps the active reference after cancel and settles once from the released real result', async () => {
    let resolveCompletion!: (outcome: SubagentFinalOutcome) => void;
    const completion = new Promise<SubagentFinalOutcome>(resolve => { resolveCompletion = resolve; });
    const execution = makeExecution(completion);
    const runVerifier = vi.fn(async () => execution);
    const { manager, clawDir } = await makeManager(runVerifier);
    const contractId = await createVerifiedContract(manager, clawDir);
    const internals = manager as unknown as ManagerInternals;

    let settled = false;
    const verifier = internals.runLLMVerification(
      'verification/t1.prompt.txt',
      path.join(clawDir, 'contract', 'active', contractId),
      contractId,
      makeSubtaskId('t1'),
      'T1',
      'evidence',
      [],
      '33333333-3333-3333-3333-333333333333',
    ).then(result => {
      settled = true;
      return result;
    });
    await waitFor(() => manager.getActiveVerifierCount() === 1 && runVerifier.mock.calls.length === 1);

    const entry = [...internals._activeContractControllers.get(contractId)!][0];
    expect(entry.identity).toEqual(identity);
    expect(entry.promise).toBe(completion);

    const cancelled = await manager.cancel(contractId, 'stop requested');
    expect(cancelled.commit.kind).toBe('committed');
    expect(manager.hasActiveVerifiers(contractId)).toBe(true);
    expect(settled).toBe(false);
    expect(runVerifier).toHaveBeenCalledTimes(1);

    resolveCompletion(makeOutcome('completed', {
      rawResult: { text: '', capturedResult: { passed: false, reason: 'actual rejection' } },
    }));
    await expect(verifier).resolves.toMatchObject({
      passed: false,
      structured: { passed: false, reason: 'actual rejection' },
    });

    expect(runVerifier).toHaveBeenCalledTimes(1);
    expect(runVerifier).toHaveBeenCalledWith(expect.objectContaining({
      agentId: `verifier-${contractId}-33333333333333333333333333333333`,
    }));
    expect(manager.hasActiveVerifiers(contractId)).toBe(false);
  });

  it('records an interrupted execution without consuming the business rejection retry', async () => {
    let resolveCompletion!: (outcome: SubagentFinalOutcome) => void;
    const completion = new Promise<SubagentFinalOutcome>(resolve => { resolveCompletion = resolve; });
    const execution = makeExecution(completion);
    const runVerifier = vi.fn(async () => execution);
    const { manager, clawDir, emitter } = await makeManager(runVerifier);
    const contractId = await createVerifiedContract(manager, clawDir);

    await expect(completeSubtask(manager, {
      contractId,
      subtaskId: makeSubtaskId('t1'),
      evidence: 'evidence',
    })).resolves.toMatchObject({ async: true });
    await waitFor(() => runVerifier.mock.calls.length === 1);
    const inProgress = await manager.getProgress(contractId);
    const acceptedAttemptId = inProgress?.subtasks.t1.verification_attempt_id;
    expect(acceptedAttemptId).toEqual(expect.any(String));
    expect(runVerifier).toHaveBeenCalledWith(expect.objectContaining({
      agentId: `verifier-${contractId}-${acceptedAttemptId?.replaceAll('-', '')}`,
    }));

    const backgroundDone = waitForNextAuditEvent(
      emitter,
      CONTRACT_AUDIT_EVENTS.VERIFICATION_BACKGROUND_DONE,
    );
    // time-fixture: typed interruption payload, not an independent wait budget.
    const cause = new ToolTimeoutError('idle timeout', { timeoutMs: 100 });
    resolveCompletion(makeOutcome('interrupted', { cause }));
    await backgroundDone;

    const progress = await manager.getProgress(contractId);
    expect(progress?.subtasks.t1).toMatchObject({ status: 'todo' });
    expect(progress?.subtasks.t1.retry_count).toBeUndefined();
    expect(progress?.subtasks.t1.last_failed_feedback).toBeUndefined();
    expect(runVerifier).toHaveBeenCalledTimes(1);
    expect(manager.getActiveVerifierCount()).toBe(0);
  });
});
