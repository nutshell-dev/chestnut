/**
 * verifier invariants merged test file (test reorganization — mechanical merge,
 * 不改任何断言逻辑)
 *
 * 本文件由以下源文件合并而来（每个源文件对应一个顶层 describe 块，内容逐字保留）:
 * 1. verifier-job-signal-audit.test.ts
 * 2. verifier-job-cancel-skip.test.ts
 * 3. verifier-job-no-workspace-dir-invariant.test.ts
 * 4. verifier-emit-contract-id-col.test.ts
 * 5. verifier-robustness.test.ts
 *
 * 改名说明: 三个源文件的 vi.hoisted mockRunSubagent 同名，分别改名为
 * mockRunSubagentSignalAudit / mockRunSubagentCancelSkip / mockRunSubagentRobustness;
 * verifier-robustness 的模块级 local makeAudit 改名 makeAuditRobustness
 * (避免与 helpers/audit.js 的 makeAudit import shadow)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import { runContractVerifier } from '../../../src/core/contract/verifier-job.js';
import { runVerificationInBackground } from '../../../src/core/contract/verification.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { CONTRACT_ACTIVE_DIR } from '../../../src/core/contract/dirs.js';
import {
  emitContractVerifierFailed,
  emitContractVerifierSkipped,
  emitContractVerifierStarted,
  emitContractVerifierPassed,
  emitContractVerifierResultParseFailed,
} from '../../../src/core/contract/audit-emit.js';
import { ToolTimeoutError } from '../../../src/foundation/tools/errors.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';
import type { VerifierConfig, ContractYaml } from '../../../src/core/contract/types.js';

const { mockRunSubagentSignalAudit } = vi.hoisted(() => ({
  mockRunSubagentSignalAudit: vi.fn(),
}));

const { mockRunSubagentCancelSkip } = vi.hoisted(() => ({
  mockRunSubagentCancelSkip: vi.fn(),
}));

const { mockRunSubagentRobustness } = vi.hoisted(() => ({
  mockRunSubagentRobustness: vi.fn(),
}));

/**
 * verifier-job signal + catch audit emit tests (phase 993 / r121 J fork)
 *
 * D.1 signal propagation + D.2 catch audit emit reverse tests.
 * Mirrors verifier-job.test.ts mock pattern + makeAudit fixture.
 */
describe('phase 993: verifier-job D.1 signal + D.2 catch audit emit', () => {
  function makeConfig(overrides: Partial<VerifierConfig> = {}): VerifierConfig {
    return {
      agentId: 'verifier-test',
      clawId: 'claw-test',
      clawDir: '/tmp/claw',
      fs: {} as unknown as VerifierConfig['fs'],
      llm: {} as unknown as VerifierConfig['llm'],
      prompt: 'test prompt',
      toolRegistry: {
        getForProfile: vi.fn().mockReturnValue([]),
      } as unknown as VerifierConfig['toolRegistry'],
      fsFactory: vi.fn(() => ({}) as unknown as VerifierConfig['fs']),
      runSubagent: mockRunSubagentSignalAudit,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockRunSubagentSignalAudit.mockReset();
  });

  it('signal abort → propagates abort without VERIFIER_FAILED audit emit', async () => {
    const { audit, events } = makeAudit();
    const controller = new AbortController();

    // mock runSubagent to hang until aborted, then throw
    mockRunSubagentSignalAudit.mockImplementation(async ({ signal }: { signal?: AbortSignal }) => {
      return new Promise((_, reject) => {
        const onAbort = () => reject(new Error('AbortError: signal aborted'));
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort);
      });
    });

    const promise = runContractVerifier(makeConfig({
      audit,
      signal: controller.signal,
    }));

    controller.abort();
    await expect(promise).rejects.toThrow('AbortError: signal aborted');

    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeUndefined();
  });

  it('ToolTimeoutError → VERIFIER_FAILED audit emit (kind=timeout)', async () => {
    const { audit, events } = makeAudit();

    mockRunSubagentSignalAudit.mockRejectedValue(new ToolTimeoutError('timeout', { timeoutMs: 100 }));

    const result = await runContractVerifier(makeConfig({ audit }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('超时');

    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain('agentId=verifier-test');
    expect(failedRow).toContain('clawId=claw-test');
    expect(failedRow).toContain('kind=timeout');
  });

  it('generic error → VERIFIER_FAILED audit emit (kind=other) with reason', async () => {
    const { audit, events } = makeAudit();

    mockRunSubagentSignalAudit.mockRejectedValue(new Error('boom'));

    const result = await runContractVerifier(makeConfig({ audit }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('boom');

    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain('agentId=verifier-test');
    expect(failedRow).toContain('clawId=claw-test');
    expect(failedRow).toContain('kind=other');
    expect(failedRow).toContain('reason=boom');
  });
});

/**
 * verifier-job cancel skip tests (phase 1080)
 *
 * Crash-recovery: verifier reads progress.json on start, skips if status=cancelled.
 */
describe('phase 1080: verifier-job cancel skip', () => {
  function makeConfig(overrides: Partial<VerifierConfig> = {}): VerifierConfig {
    return {
      agentId: 'verifier-test-contract-1',
      clawId: 'claw-test',
      clawDir: '/tmp/claw',
      contractId: 'test-contract-1',
      fs: {
        read: vi.fn(),
      } as unknown as VerifierConfig['fs'],
      llm: {} as unknown as VerifierConfig['llm'],
      prompt: 'test prompt',
      toolRegistry: {
        getForProfile: vi.fn().mockReturnValue([]),
      } as unknown as VerifierConfig['toolRegistry'],
      fsFactory: vi.fn(() => ({}) as unknown as VerifierConfig['fs']),
      runSubagent: mockRunSubagentCancelSkip,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockRunSubagentCancelSkip.mockReset();
  });

  // Step E: verifier preflight uses strict active schema; persisted lifecycle
  // status literals are rejected as schema-invalid, not as runnable state checks.
  it('skips verifier when progress.json contains a persisted status literal', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      read: vi.fn().mockResolvedValue(JSON.stringify({ status: 'cancelled' })),
    };

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toBe('Contract progress.json schema invalid — verifier aborting');
    expect(mockRunSubagentCancelSkip).not.toHaveBeenCalled();

    const skippedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED);
    expect(skippedRow).toBeDefined();
    expect(skippedRow).toContain('agentId=verifier-test-contract-1');
    expect(skippedRow).toContain('reason=progress_schema_invalid');
  });

  it.each(['paused', 'crashed', 'archive_pending_recovery'] as const)(
    'Step E: persisted status %s is treated as schema invalid',
    async (status) => {
      const { audit, events } = makeAudit();
      const fs = {
        read: vi.fn().mockResolvedValue(JSON.stringify({ status })),
      };

      const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

      expect(result.passed).toBe(false);
      expect(result.feedback).toBe('Contract progress.json schema invalid — verifier aborting');
      expect(mockRunSubagentCancelSkip).not.toHaveBeenCalled();

      const skippedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED);
      expect(skippedRow).toBeDefined();
      expect(skippedRow).toContain('reason=progress_schema_invalid');
    },
  );

  it('runs verifier normally when active progress.json is valid current schema', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      read: vi.fn().mockResolvedValue(JSON.stringify({ schema_version: 1, subtasks: { t1: { status: 'todo' } } })),
    };
    mockRunSubagentCancelSkip.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok' },
    });

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(true);
    expect(mockRunSubagentCancelSkip).toHaveBeenCalledTimes(1);

    const skippedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED);
    expect(skippedRow).toBeUndefined();
  });

  // phase 324 C4: ENOENT 改短路（contract 已 move 出 active/，verifier 没目的地）。
  it('phase 324 C4: skips verifier when progress.json does not exist (ENOENT → no longer active)', async () => {
    const { audit, events } = makeAudit();
    const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const fs = {
      read: vi.fn().mockRejectedValue(err),
    };

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('no longer in active');
    expect(mockRunSubagentCancelSkip).not.toHaveBeenCalled();

    const skippedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED);
    expect(skippedRow).toBeDefined();
    expect(skippedRow).toContain('reason=contract_no_longer_active');
  });

  it('fails closed without launching LLM when progress schema is invalid', async () => {
    const { audit, events } = makeAudit();
    const fs = {
      read: vi.fn().mockResolvedValue(JSON.stringify({ status: 123 })),
    };

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('schema invalid');
    expect(mockRunSubagentCancelSkip).not.toHaveBeenCalled();

    const skippedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED);
    expect(skippedRow).toBeDefined();
    expect(skippedRow).toContain('agentId=verifier-test-contract-1');
    expect(skippedRow).toContain('reason=progress_schema_invalid');
  });

  it('fails closed when progress.json read fails with non-ENOENT error', async () => {
    const { audit, events } = makeAudit();
    const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    const fs = {
      read: vi.fn().mockRejectedValue(err),
    };

    const result = await runContractVerifier(makeConfig({ audit, fs: fs as unknown as VerifierConfig['fs'] }));

    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('Cannot read contract progress');
    expect(mockRunSubagentCancelSkip).not.toHaveBeenCalled();

    const failedRow = events.find(e => e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED);
    expect(failedRow).toBeDefined();
    expect(failedRow).toContain('agentId=verifier-test-contract-1');
    expect(failedRow).toContain('kind=io_error');
    expect(failedRow).toContain('reason=[EACCES] EACCES: permission denied');
  });

  it('runs verifier when contractId is not provided (backward compat)', async () => {
    const { audit } = makeAudit();
    mockRunSubagentCancelSkip.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok' },
    });

    const result = await runContractVerifier(makeConfig({ contractId: undefined, audit }));

    expect(result.passed).toBe(true);
    expect(mockRunSubagentCancelSkip).toHaveBeenCalledTimes(1);
  });
});

/**
 * @module tests/core/contract/verifier-job-no-workspace-dir-invariant
 * Phase 1371 sub-6: verifier-job signal abort cleanup invariant test
 *
 * Enforces the phase 805 assumption: runSubagent does NOT create a subagent workspace dir.
 *
 * NEW hit ratchet (`ensureDir|mkdir(workspace)`) 已迁 ESLint custom rule
 * `chestnut-custom/no-subagent-ensuredir-workspace` (phase 402)。本 file 仅留
 * cross-file aggregate count baseline (ESLint per-file scope 不擅长跨文件 count)。
 */
describe('verifier-job no-workspace-dir invariant (phase 1371 sub-6 count baseline)', () => {
  function readSrcFiles(dir: string): string[] {
    const root = path.resolve(process.cwd(), dir);
    const results: string[] = [];
    for (const entry of readdirSync(root)) {
      const full = path.join(root, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        results.push(...readSrcFiles(path.join(dir, entry)));
      } else if (full.endsWith('.ts')) {
        results.push(full);
      }
    }
    return results;
  }

  it('subagent source baseline: ensureDir is only used for resultDir (count = 2)', () => {
    const files = readSrcFiles('src/core/subagent');
    let ensureDirCount = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const matches = content.match(/ensureDir\(/g);
      if (matches) ensureDirCount += matches.length;
    }

    // Current baseline: run.ts (1) + agent.ts (1) = 2 ensureDir calls for resultDir
    // If this number increases, a human must verify it's not workspace dir creation.
    // (NEW workspace dir ensureDir 已由 ESLint `no-subagent-ensuredir-workspace` 守 phase 402)
    expect(ensureDirCount).toBe(2);
  });
});

describe('phase 1151 r127 F fork Step B: verifier emit contractId col', () => {
  function makeFakeAudit() {
    const writes: Array<{ event: string; cols: string[] }> = [];
    return {
      audit: { write: (event: string, ...cols: string[]) => { writes.push({ event, cols }); } , preview: (s: string) => s, message: (s: string) => s, summary: (s: string) => s} as any,
      writes,
    };
  }

  it('reverse 1: emit fn opts 强约束 contractId field (ts 编译期 enforce)', () => {
    // 此 test 仅占位、ts 编译报错才是真断言
    const { audit, writes } = makeFakeAudit();
    // @ts-expect-error: contractId required
    emitContractVerifierPassed(audit, { agentId: 'a' });
    expect(writes).toHaveLength(1);
  });

  it('reverse 2: emit 传空字符串 contractId → invariant violation audit + early return / 0 cols emit', () => {
    const { audit, writes } = makeFakeAudit();
    emitContractVerifierPassed(audit, { contractId: '', agentId: 'verifier-cid-abc-sub1' });
    expect(writes).toHaveLength(1);
    expect(writes[0].event).toBe(CONTRACT_AUDIT_EVENTS.TYPED_EMIT_INVARIANT_VIOLATION);
    expect(writes[0].cols).toContain('field=contractId');
    expect(writes[0].cols).toContain('event=emitContractVerifierPassed');
    expect(writes[0].cols).toContain('reason=empty_string');
  });

  it('reverse 3: emit 传正常 contractId / 5 fn cols 全含 contractId= 首位', () => {
    const checks: Array<{ name: string; emit: (audit: any) => void; expectedEvent: string; expectedFirstCol: string }> = [
      {
        name: 'failed',
        emit: (a) => emitContractVerifierFailed(a, { contractId: 'cid-abc-123', agentId: 'aid', clawId: 'claw1', kind: 'k', reason: 'r' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_FAILED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
      {
        name: 'skipped',
        emit: (a) => emitContractVerifierSkipped(a, { contractId: 'cid-abc-123', agentId: 'aid', reason: 'r' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_SKIPPED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
      {
        name: 'started',
        emit: (a) => emitContractVerifierStarted(a, { contractId: 'cid-abc-123', agentId: 'aid', clawId: 'c1' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_STARTED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
      {
        name: 'passed',
        emit: (a) => emitContractVerifierPassed(a, { contractId: 'cid-abc-123', agentId: 'aid' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_PASSED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
      {
        name: 'result_parse_failed',
        emit: (a) => emitContractVerifierResultParseFailed(a, { contractId: 'cid-abc-123', agentId: 'aid', clawId: 'c1', stage: 's', reason: 'r' }),
        expectedEvent: CONTRACT_AUDIT_EVENTS.VERIFIER_RESULT_PARSE_FAILED,
        expectedFirstCol: 'contractId=cid-abc-123',
      },
    ];

    for (const c of checks) {
      const { audit, writes } = makeFakeAudit();
      c.emit(audit);
      expect(writes, c.name).toHaveLength(1);
      expect(writes[0].event, c.name).toBe(c.expectedEvent);
      expect(writes[0].cols[0], c.name).toBe(c.expectedFirstCol);  // contractId= 首位、紧跟 agentId
    }
  });
});

/**
 * phase 1133 / r126 C fork — contract verifier robustness 反向 3 项
 *
 * 反向:
 * 1. verifier-job uses CONTRACT_ACTIVE_DIR via path.join (C-1)
 * 2. cancel between lock and archive → no archiveAndEmit + COMPLETE_ON_CANCELLED audit (C-2)
 * 3. invalid JSON in done.result emits audit + verifier still returns success via text parse (C-3)
 */
describe('phase 1133 C fork — contract verifier robustness', () => {
  function makeAuditRobustness() {
    const events: Array<[string, ...(string | number)[]]> = [];
    const audit = {
      write: (type: string, ...cols: (string | number)[]) => {
        events.push([type, ...cols]);
      },
      preview: (s: string) => s,
      message: (s: string) => s,
      summary: (s: string) => s,
    };
    return { audit, events };
  }

  function makeConfig(overrides: Partial<VerifierConfig> = {}): VerifierConfig {
    return {
      agentId: 'verifier-test',
      clawId: 'claw-test',
      clawDir: '/tmp/claw',
      fs: {
        read: vi.fn(),
      } as unknown as VerifierConfig['fs'],
      llm: {} as unknown as VerifierConfig['llm'],
      audit: makeMockAudit() as unknown as VerifierConfig['audit'],
      prompt: 'test prompt',
      toolRegistry: {
        getForProfile: vi.fn().mockReturnValue([]),
      } as unknown as VerifierConfig['toolRegistry'],
      fsFactory: vi.fn(() => ({}) as unknown as VerifierConfig['fs']),
      runSubagent: mockRunSubagentRobustness,
      ...overrides,
    };
  }

  beforeEach(() => {
    mockRunSubagentRobustness.mockReset();
  });

  // ───── 反向 1 (C-1 path const) ─────
  it('反向 1 (C-1 path const): verifier-job uses CONTRACT_ACTIVE_DIR via path.join', async () => {
    const { audit, events } = makeAuditRobustness();
    const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const fsReadSpy = vi.fn().mockRejectedValue(err);

    mockRunSubagentRobustness.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok' },
    });

    await runContractVerifier(
      makeConfig({
        contractId: 'test-contract-1',
        audit: audit as unknown as VerifierConfig['audit'],
        fs: { read: fsReadSpy } as unknown as VerifierConfig['fs'],
      }),
    );

    expect(fsReadSpy).toHaveBeenCalledTimes(1);
    expect(fsReadSpy).toHaveBeenCalledWith(
      path.join(CONTRACT_ACTIVE_DIR, 'test-contract-1', 'progress.json'),
    );
  });

  // ───── 反向 2 (C-2 archive race guard) ─────
  it('反向 2 (C-2 archive race guard): cancel between lock and archive → no archiveAndEmit + COMPLETE_ON_CANCELLED audit', async () => {
    const { audit, events } = makeAuditRobustness();
    const moveToArchiveSpy = vi.fn().mockResolvedValue(undefined);
    const emitContractCompletedSpy = vi.fn().mockResolvedValue(undefined);

    const ctx = {
      fs: {
        read: vi.fn().mockResolvedValue(''),
        writeFile: vi.fn().mockResolvedValue(undefined),
        writeExclusiveSync: vi.fn(),
        writeAtomicSync: vi.fn(),
        ensureDir: vi.fn().mockResolvedValue(undefined),
        ensureDirSync: vi.fn(),
      },
      audit: audit as any,
      clawDir: '/tmp/claw',
      clawId: 'test-claw',
      notifyClaw: vi.fn(),
      contractDir: vi.fn()
        .mockResolvedValueOnce('contract/active')
        .mockResolvedValueOnce('contract/archive/cancelled'),
      loadContractYaml: vi.fn().mockResolvedValue({}),
      getProgress: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'running',
          subtasks: { t1: { status: 'in_progress' } },
        })
        .mockResolvedValueOnce({
          status: 'cancelled',
          subtasks: { t1: { status: 'completed' } },
        }),
      saveProgress: vi.fn().mockResolvedValue(undefined),
      checkAllSubtasksCompleted: vi.fn().mockResolvedValue(true),
      moveContractToArchive: moveToArchiveSpy,
      emitContractCompleted: emitContractCompletedSpy,
      runLLMVerification: vi.fn().mockResolvedValue({ passed: true }),
      withProgressLock: vi.fn().mockImplementation((_, fn) => fn()),
      toolRegistry: { getForProfile: vi.fn().mockReturnValue([]) } as any,
    };

    const contractYaml: ContractYaml = {
      title: 'Test',
      goal: 'Test',
      subtasks: [{ id: 't1', description: 'T1' }],
      verification: [{ subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' }],
    };

    await runVerificationInBackground(
      ctx as any,
      { contractId: 'c1', subtaskId: 't1', evidence: 'evidence' },
      contractYaml,
      { subtask_id: 't1', type: 'llm', prompt_file: 'verification/t1.prompt.txt' },
    );

    expect(moveToArchiveSpy).not.toHaveBeenCalled();
    expect(emitContractCompletedSpy).not.toHaveBeenCalled();

    const cancelAudit = events.find(
      (e) =>
        e[0] === CONTRACT_AUDIT_EVENTS.COMPLETE_ON_CANCELLED &&
        e.some((col) => col === 'context=runVerificationInBackground'),
    );
    expect(cancelAudit).toBeDefined();
    expect(cancelAudit).toContain('contractId=c1');
    expect(cancelAudit).toContain('subtaskId=t1');
  });

  // ───── 反向 3 (C-3 parse-failed audit + fall-through) ─────
  it('反向 3 (C-3 parse-failed audit + fall-through): invalid JSON in done.result emits audit + verifier still returns success via text parse', async () => {
    const { audit, events } = makeAuditRobustness();

    // runSubagent 返回 capturedResult.result 为非法 JSON，但 text 包含合法 JSON
    mockRunSubagentRobustness.mockResolvedValue({
      text: '{"passed":true,"reason":"ok"}',
      capturedResult: { result: '{invalid json' },
    });

    const result = await runContractVerifier(
      makeConfig({ audit: audit as unknown as VerifierConfig['audit'] }),
    );

    const parseFailedAudit = events.find(
      (e) =>
        e[0] === CONTRACT_AUDIT_EVENTS.VERIFIER_RESULT_PARSE_FAILED &&
        e.some((col) => col === 'stage=done_result_first_parse'),
    );
    expect(parseFailedAudit).toBeDefined();
    expect(parseFailedAudit).toContain('agentId=verifier-test');
    expect(parseFailedAudit).toContain('clawId=claw-test');
    expect(parseFailedAudit?.some((c) => String(c).startsWith('reason='))).toBe(true);

    // fall-through 行为保留：text JSON 解析成功
    expect(result.passed).toBe(true);
    expect(result.structured).toEqual({ passed: true, reason: 'ok' });
  });
});

/**
 * verifier-job unit tests (phase 990 / r121 F fork)
 *
 * Tests runContractVerifier result-parsing paths via mocked runSubagent.
 * Pure-logic cluster: capturedResult, JSON codeblock, plain JSON, parse error, timeout, generic error.
 */

const { mockRunSubagentUnit } = vi.hoisted(() => ({
  mockRunSubagentUnit: vi.fn(),
}));

function makeUnitConfig(overrides: Partial<VerifierConfig> = {}): VerifierConfig {
  return {
    agentId: 'verifier-test',
    clawId: 'claw-test',
    clawDir: '/tmp/claw',
    fs: {} as unknown as VerifierConfig['fs'],
    llm: {} as unknown as VerifierConfig['llm'],
    audit: makeMockAudit() as unknown as VerifierConfig['audit'],
    prompt: 'test prompt',
    toolRegistry: {
      getForProfile: vi.fn().mockReturnValue([]),
    } as unknown as VerifierConfig['toolRegistry'],
    fsFactory: vi.fn(() => ({}) as unknown as VerifierConfig['fs']),
    runSubagent: mockRunSubagentUnit,
    ...overrides,
  };
}

describe('runContractVerifier (phase 990)', () => {
  beforeEach(() => {
    mockRunSubagentUnit.mockReset();
  });

  it('returns structured result when capturedResult is present', async () => {
    mockRunSubagentUnit.mockResolvedValue({
      text: '',
      capturedResult: { passed: true, reason: 'ok', issues: ['a'] },
    });
    const result = await runContractVerifier(makeUnitConfig());
    expect(result.passed).toBe(true);
    expect(result.structured).toEqual({ passed: true, reason: 'ok', issues: ['a'] });
  });

  it('parses JSON codeblock when no capturedResult', async () => {
    mockRunSubagentUnit.mockResolvedValue({
      text: '```json\n{"passed":true,"reason":"ok"}\n```',
    });
    const result = await runContractVerifier(makeUnitConfig());
    expect(result.passed).toBe(true);
    expect(result.structured).toEqual({ passed: true, reason: 'ok' });
  });

  it('parses bare JSON when no codeblock', async () => {
    mockRunSubagentUnit.mockResolvedValue({
      text: '{"passed":false,"reason":"nope"}',
    });
    const result = await runContractVerifier(makeUnitConfig());
    expect(result.passed).toBe(false);
    expect(result.structured).toEqual({ passed: false, reason: 'nope' });
  });

  it('returns format error when text has no JSON', async () => {
    mockRunSubagentUnit.mockResolvedValue({ text: 'plain text only' });
    const result = await runContractVerifier(makeUnitConfig());
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('格式错误');
  });

  it('returns timeout feedback on ToolTimeoutError', async () => {
    mockRunSubagentUnit.mockRejectedValue(new ToolTimeoutError('timeout', { timeoutMs: 100 }));
    const result = await runContractVerifier(makeUnitConfig());
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('超时');
  });

  it('returns failure feedback on generic error', async () => {
    mockRunSubagentUnit.mockRejectedValue(new Error('boom'));
    const result = await runContractVerifier(makeUnitConfig());
    expect(result.passed).toBe(false);
    expect(result.feedback).toContain('boom');
  });

  it('rejects legacy result with non-boolean passed field', async () => {
    mockRunSubagentUnit.mockResolvedValue({
      text: '{"passed":false,"reason":"rejected legacy shape"}',
      capturedResult: { passed: 'yes', reason: 'looks good' },
    });
    const result = await runContractVerifier(makeUnitConfig());
    expect(result.passed).toBe(false);
    expect(result.structured).toEqual({ passed: false, reason: 'rejected legacy shape' });
  });

  it('propagates signal abort instead of returning passed:false', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    mockRunSubagentUnit.mockRejectedValue(abortError);
    const config = makeUnitConfig({ signal: AbortSignal.abort() });
    await expect(runContractVerifier(config)).rejects.toThrow('Aborted');
  });
});
