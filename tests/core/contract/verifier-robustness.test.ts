/**
 * phase 1133 / r126 C fork — contract verifier robustness 反向 3 项
 *
 * 反向:
 * 1. verifier-job uses CONTRACT_ACTIVE_DIR via path.join (C-1)
 * 2. cancel between lock and archive → no archiveAndEmit + COMPLETE_ON_CANCELLED audit (C-2)
 * 3. invalid JSON in done.result emits audit + verifier still returns success via text parse (C-3)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockAudit } from '../../helpers/audit.js';
import * as path from 'path';
import { runContractVerifier } from '../../../src/core/contract/verifier-job.js';
import { runVerificationInBackground } from '../../../src/core/contract/verification.js';
import { CONTRACT_AUDIT_EVENTS } from '../../../src/core/contract/audit-events.js';
import { CONTRACT_ACTIVE_DIR } from '../../../src/core/contract/dirs.js';
import type { VerifierConfig } from '../../../src/core/contract/types.js';
import type { ContractYaml } from '../../../src/core/contract/types.js';

const { mockRunSubagent } = vi.hoisted(() => ({
  mockRunSubagent: vi.fn(),
}));

vi.mock('../../../src/core/subagent/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/core/subagent/index.js')>();
  return {
    ...mod,
    runSubagent: mockRunSubagent,
  };
});

function makeAudit() {
  const events: Array<[string, ...(string | number)[]]> = [];
  const audit = {
    write: (type: string, ...cols: (string | number)[]) => {
      events.push([type, ...cols]);
    },
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
    ...overrides,
  };
}

describe('phase 1133 C fork — contract verifier robustness', () => {
  beforeEach(() => {
    mockRunSubagent.mockReset();
  });

  // ───── 反向 1 (C-1 path const) ─────
  it('反向 1 (C-1 path const): verifier-job uses CONTRACT_ACTIVE_DIR via path.join', async () => {
    const { audit, events } = makeAudit();
    const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    const fsReadSpy = vi.fn().mockRejectedValue(err);

    mockRunSubagent.mockResolvedValue({
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
    const { audit, events } = makeAudit();
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
      contractDir: vi.fn().mockResolvedValue('contract/active'),
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
    const { audit, events } = makeAudit();

    // runSubagent 返回 capturedResult.result 为非法 JSON，但 text 包含合法 JSON
    mockRunSubagent.mockResolvedValue({
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
