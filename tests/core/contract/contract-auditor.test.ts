/**
 * phase 1424: ContractAuditor tests
 *
 * 反向 3 项：
 * 1. drift detection: mock LLM 返 on_track:false → inbox.write 调一次 priority:high + 2 audit event emit
 * 2. on_track passthrough: mock LLM 返 on_track:true → inbox.write 0 调 + DRIFT_DETECTED 0 emit
 * 3. inbox 去重：连续 drift → removeStaleAuditorMessages 删 pending 同 sender 旧消息
 *
 * 辅助：parseVerdict 单测 + maybeAudit interval guard
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
// eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { ContractAuditor, parseVerdict } from '../../../src/core/contract/contract-auditor.js';
import { InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { makeAudit } from '../../helpers/audit.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';

function makeMockLLM(verdictText: string): LLMOrchestrator {
  return {
    async call() {
      const response: LLMResponse = {
        content: [{ type: 'text', text: verdictText }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      };
      return response;
    },
    stream: () => { throw new Error('not implemented'); },
    healthCheck: async () => true,
    getProviderInfo: () => ({ name: 'mock', model: 'mock', isFallback: false }),
    close: async () => {},
  } as LLMOrchestrator;
}

describe('parseVerdict', () => {
  it('parses valid JSON verdict', () => {
    const v = parseVerdict('{"on_track": true, "drifts": [], "next_focus_suggestion": "continue"}');
    expect(v.on_track).toBe(true);
    expect(v.drifts).toEqual([]);
    expect(v.next_focus_suggestion).toBe('continue');
  });

  it('strips markdown code fence', () => {
    const v = parseVerdict('```json\n{"on_track": false, "drifts": [{"what": "X", "evidence": "step 5"}], "next_focus_suggestion": "stop X"}\n```');
    expect(v.on_track).toBe(false);
    expect(v.drifts).toEqual([{ what: 'X', evidence: 'step 5' }]);
  });

  it('extracts JSON object from surrounding text', () => {
    const v = parseVerdict('Some thinking...\n{"on_track": true, "drifts": [], "next_focus_suggestion": ""}\nDone.');
    expect(v.on_track).toBe(true);
  });

  it('throws on invalid input', () => {
    expect(() => parseVerdict('not json at all')).toThrow();
    expect(() => parseVerdict('{"missing_on_track": true}')).toThrow();
  });
});

describe('ContractAuditor', () => {
  let testDir: string;
  let nfs: NodeFileSystem;
  let inboxDir: string;
  let inbox: InboxWriter;
  const clawId = 'test-claw';

  beforeEach(async () => {
    testDir = path.join(tmpdir(), `auditor-${randomUUID()}`);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
    await fs.mkdir(testDir, { recursive: true });
    inboxDir = path.join(testDir, 'inbox', 'pending');
    await fs.mkdir(inboxDir, { recursive: true });
    nfs = new NodeFileSystem({ baseDir: testDir });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => { /* silent: cleanup */ });
  });

  function makeAuditorAndAudit(verdictText: string) {
    const auditCtx = makeAudit();
    const inboxAudit = makeAudit();
    inbox = InboxWriter.__internal_create(nfs, makeInboxPath('inbox/pending'), inboxAudit.audit);
    const auditor = new ContractAuditor({
      audit: auditCtx.audit,
      fs: nfs,
      inbox,
      llm: makeMockLLM(verdictText),
      inboxPendingDir: 'inbox/pending',
    });
    return { auditor, auditEvents: auditCtx.events };
  }

  function defaultReq(overrides?: Partial<Parameters<ContractAuditor['maybeAudit']>[0]>) {
    return {
      contractId: 'c-1',
      contractTitle: 'Test Contract',
      clawId,
      currentStep: 50,
      auditInterval: 50,
      lastAuditedStep: 0,
      expectations: 'do X, do Y',
      contractStartedAt: undefined,
      progress: { done: [], in_progress: 's1', pending: ['s2'] },
      ...overrides,
    };
  }

  it('反向 1: drift detection — inbox.write delivers high priority + audit events emit', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(
      '{"on_track": false, "drifts": [{"what": "grep loop", "evidence": "step 40-49"}], "next_focus_suggestion": "submit subtask"}',
    );

    const out = await auditor.maybeAudit(defaultReq());
    expect(out.audited).toBe(true);
    expect(out.verdict?.on_track).toBe(false);

    // 3 audit event emit
    const emittedTypes = auditEvents.map(e => e[0]);
    expect(emittedTypes).toContain('contract_audit_triggered');
    expect(emittedTypes).toContain('contract_audit_drift_detected');
    expect(emittedTypes).toContain('contract_audit_feedback_delivered');

    // inbox 文件落盘
    const pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(1);
    const fileName = pending[0]!;
    expect(fileName).toContain('contract-auditor-c-1');
    expect(fileName).toContain('_high_');
    const content = await fs.readFile(path.join(inboxDir, fileName), 'utf-8');
    expect(content).toContain('grep loop');
    expect(content).toContain('submit subtask');
  });

  it('反向 2: on_track passthrough — inbox.write 0 调 + DRIFT_DETECTED 0 emit', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(
      '{"on_track": true, "drifts": [], "next_focus_suggestion": ""}',
    );

    const out = await auditor.maybeAudit(defaultReq());
    expect(out.audited).toBe(true);
    expect(out.verdict?.on_track).toBe(true);

    const emittedTypes = auditEvents.map(e => e[0]);
    expect(emittedTypes).toContain('contract_audit_triggered');
    expect(emittedTypes).not.toContain('contract_audit_drift_detected');
    expect(emittedTypes).not.toContain('contract_audit_feedback_delivered');

    // 0 inbox 文件
    const pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(0);
  });

  it('反向 3: inbox 去重 — 连续 drift 时 pending 内同 sender 旧文件被删', async () => {
    const { auditor: a1 } = makeAuditorAndAudit(
      '{"on_track": false, "drifts": [{"what": "A", "evidence": "step 50"}], "next_focus_suggestion": "x"}',
    );
    await a1.maybeAudit(defaultReq({ currentStep: 50 }));
    let pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(1);
    const firstName = pending[0]!;

    // 第二次 audit：构造新 auditor 实例（同 deps 不可重用、用各自 audit sink），limit minDeliveryIntervalMs 跳过
    // 因此先 spin 现有 auditor 内部 lastDeliveredBySender 失效 = 用新实例
    const { auditor: a2 } = makeAuditorAndAudit(
      '{"on_track": false, "drifts": [{"what": "B", "evidence": "step 100"}], "next_focus_suggestion": "y"}',
    );
    await a2.maybeAudit(defaultReq({ currentStep: 100 }));
    pending = await fs.readdir(inboxDir);
    // 去重生效：仍是 1 个文件（旧的被删、新的写入）
    expect(pending.length).toBe(1);
    expect(pending[0]).not.toBe(firstName);
  });

  it('skips when auditInterval <= 0', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit('{"on_track": true, "drifts": [], "next_focus_suggestion": ""}');
    const out = await auditor.maybeAudit(defaultReq({ auditInterval: 0 }));
    expect(out.audited).toBe(false);
    expect(out.reason).toBe('audit_interval_disabled');
    expect(auditEvents.length).toBe(0);
  });

  it('skips when currentStep - lastAuditedStep < auditInterval', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit('{"on_track": true, "drifts": [], "next_focus_suggestion": ""}');
    const out = await auditor.maybeAudit(defaultReq({ auditInterval: 50, currentStep: 30, lastAuditedStep: 0 }));
    expect(out.audited).toBe(false);
    expect(out.reason).toBe('interval_not_reached');
    expect(auditEvents.length).toBe(0);
  });

  it('skips when expectations is undefined', async () => {
    const { auditor } = makeAuditorAndAudit('{"on_track": true, "drifts": [], "next_focus_suggestion": ""}');
    const out = await auditor.maybeAudit(defaultReq({ expectations: undefined }));
    expect(out.audited).toBe(false);
    expect(out.reason).toBe('no_expectations');
  });
});
