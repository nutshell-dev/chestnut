/**
 * phase 1424: ContractAuditor tests
 *
 * 反向 3 项：
 * 1. drift detection: mock LLM 返 on_track:false → inbox.write 调一次 priority:high + audit event emit
 * 2. on_track passthrough: mock LLM 返 on_track:true → inbox.write 0 调 + DRIFT_DETECTED 0 emit
 * 3. inbox 去重：连续 drift → removeStaleAuditorMessages 删 pending 同 sender 旧消息
 *
 * 辅助：parseVerdict 单测 + maybeAudit interval guard
 *
 * phase 1830: 有效性门 — 不完整结果（空 drifts / 空白 what/evidence / 混合 / 非字符串建议 /
 * 自相矛盾）整份不投递、不删旧 pending，RESULT_RECORDED 留存原始返回、DISPOSITION 记处置；
 * 限流/删除失败/写失败/LLM 失败/footprint 失败各自记真实阶段，不混称 llm_call_failed。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { ContractAuditor, parseVerdict } from '../../../src/core/contract/contract-auditor.js';
import { InboxWriter, makeInboxPath } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { makeAudit } from '../../helpers/audit.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
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

function makeThrowingLLM(err: Error): LLMOrchestrator {
  return {
    async call() { throw err; },
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
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
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

  function makeAuditorAndAudit(llm: LLMOrchestrator) {
    const auditCtx = makeAudit();
    const inboxAudit = makeAudit();
    inbox = InboxWriter.__internal_create(nfs, makeInboxPath('inbox/pending'), inboxAudit.audit, MESSAGING_WRITER_LIMITS_DEFAULT);
    const auditor = new ContractAuditor({
      audit: auditCtx.audit,
      fs: nfs,
      inbox,
      llm,
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

  /** 取某事件类型的所有 emit（cols 数组）。 */
  function eventsOf(auditEvents: Array<[string, ...(string | number)[]]>, type: string) {
    return auditEvents.filter(e => e[0] === type);
  }

  /** 从事件 cols 中取 key=value 的 value。 */
  function colValue(cols: (string | number)[], key: string): string | undefined {
    const hit = cols.find(c => typeof c === 'string' && c.startsWith(`${key}=`));
    return typeof hit === 'string' ? hit.slice(key.length + 1) : undefined;
  }

  it('反向 1: drift detection — inbox.write delivers high priority + audit events emit', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "grep loop", "evidence": "step 40-49"}], "next_focus_suggestion": "submit subtask"}',
    ));

    const out = await auditor.maybeAudit(defaultReq());
    expect(out.audited).toBe(true);
    expect(out.verdict?.on_track).toBe(false);

    // audit event emit
    const emittedTypes = auditEvents.map(e => e[0]);
    expect(emittedTypes).toContain('contract_audit_triggered');
    expect(emittedTypes).toContain('contract_audit_result_recorded');
    expect(emittedTypes).toContain('contract_audit_drift_detected');
    expect(emittedTypes).toContain('contract_audit_feedback_delivered');
    // 处置链：同 reviewId 关联 result_recorded / disposition / delivered
    const reviewId = colValue(eventsOf(auditEvents, 'contract_audit_result_recorded')[0]!.slice(1), 'reviewId');
    expect(reviewId).toBeTruthy();
    const dispositions = eventsOf(auditEvents, 'contract_audit_feedback_disposition');
    expect(dispositions.length).toBe(1);
    expect(colValue(dispositions[0]!.slice(1), 'reviewId')).toBe(reviewId);
    expect(colValue(dispositions[0]!.slice(1), 'disposition')).toBe('delivered');
    expect(colValue(eventsOf(auditEvents, 'contract_audit_feedback_delivered')[0]!.slice(1), 'reviewId')).toBe(reviewId);

    // inbox 文件落盘：正文自含身份、依据与建议
    const pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(1);
    const fileName = pending[0]!;
    expect(fileName).toContain('contract-auditor-c-1');
    expect(fileName).toContain('_high_');
    const content = await fs.readFile(path.join(inboxDir, fileName), 'utf-8');
    expect(content).toContain('grep loop');
    expect(content).toContain('step 40-49');
    expect(content).toContain('submit subtask');
    expect(content).toContain('Test Contract');
    expect(content).toContain('c-1');
  });

  it('反向 2: on_track passthrough — inbox.write 0 调 + DRIFT_DETECTED 0 emit + disposition on_track', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": true, "drifts": [], "next_focus_suggestion": ""}',
    ));

    const out = await auditor.maybeAudit(defaultReq());
    expect(out.audited).toBe(true);
    expect(out.verdict?.on_track).toBe(true);

    const emittedTypes = auditEvents.map(e => e[0]);
    expect(emittedTypes).toContain('contract_audit_triggered');
    expect(emittedTypes).toContain('contract_audit_result_recorded');
    expect(emittedTypes).not.toContain('contract_audit_drift_detected');
    expect(emittedTypes).not.toContain('contract_audit_feedback_delivered');
    const dispositions = eventsOf(auditEvents, 'contract_audit_feedback_disposition');
    expect(dispositions.length).toBe(1);
    expect(colValue(dispositions[0]!.slice(1), 'disposition')).toBe('on_track');

    // 0 inbox 文件
    const pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(0);
  });

  it('反向 3: inbox 去重 — 连续 drift 时 pending 内同 sender 旧文件被删', async () => {
    const { auditor: a1 } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "A", "evidence": "step 50"}], "next_focus_suggestion": "x"}',
    ));
    await a1.maybeAudit(defaultReq({ currentStep: 50 }));
    let pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(1);
    const firstName = pending[0]!;

    // 第二次 audit：构造新 auditor 实例（同 deps 不可重用、用各自 audit sink），limit minDeliveryIntervalMs 跳过
    // 因此先 spin 现有 auditor 内部 lastDeliveredBySender 失效 = 用新实例
    const { auditor: a2 } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "B", "evidence": "step 100"}], "next_focus_suggestion": "y"}',
    ));
    await a2.maybeAudit(defaultReq({ currentStep: 100 }));
    pending = await fs.readdir(inboxDir);
    // 去重生效：仍是 1 个文件（旧的被删、新的写入）
    expect(pending.length).toBe(1);
    expect(pending[0]).not.toBe(firstName);
  });

  it('skips when auditInterval <= 0', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM('{"on_track": true, "drifts": [], "next_focus_suggestion": ""}'));
    const out = await auditor.maybeAudit(defaultReq({ auditInterval: 0 }));
    expect(out.audited).toBe(false);
    expect(out.reason).toBe('audit_interval_disabled');
    expect(auditEvents.length).toBe(0);
  });

  it('skips when currentStep - lastAuditedStep < auditInterval', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM('{"on_track": true, "drifts": [], "next_focus_suggestion": ""}'));
    const out = await auditor.maybeAudit(defaultReq({ auditInterval: 50, currentStep: 30, lastAuditedStep: 0 }));
    expect(out.audited).toBe(false);
    expect(out.reason).toBe('interval_not_reached');
    expect(auditEvents.length).toBe(0);
  });

  it('skips when expectations is undefined', async () => {
    const { auditor } = makeAuditorAndAudit(makeMockLLM('{"on_track": true, "drifts": [], "next_focus_suggestion": ""}'));
    const out = await auditor.maybeAudit(defaultReq({ expectations: undefined }));
    expect(out.audited).toBe(false);
    expect(out.reason).toBe('no_expectations');
  });

  // ====================================================================
  // phase 1830: 有效性门分支矩阵
  // ====================================================================

  const INVALID_CASES: Array<{ name: string; verdict: string; reasonMatch: RegExp }> = [
    {
      name: 'false + 空 drifts 数组',
      verdict: '{"on_track": false, "drifts": [], "next_focus_suggestion": "x"}',
      reasonMatch: /no valid drift entries/,
    },
    {
      name: 'false + drifts 非数组',
      verdict: '{"on_track": false, "drifts": "oops", "next_focus_suggestion": "x"}',
      reasonMatch: /not an array/,
    },
    {
      name: 'false + 空白 what',
      verdict: '{"on_track": false, "drifts": [{"what": "  ", "evidence": "step 5"}]}',
      reasonMatch: /what missing or blank/,
    },
    {
      name: 'false + 缺 evidence',
      verdict: '{"on_track": false, "drifts": [{"what": "loop"}]}',
      reasonMatch: /evidence missing or blank/,
    },
    {
      name: 'false + 非法条目（非对象）',
      verdict: '{"on_track": false, "drifts": ["just a string"]}',
      reasonMatch: /not an object/,
    },
    {
      name: 'false + 有效无效混合（整份不投递、不悄悄过滤）',
      verdict: '{"on_track": false, "drifts": [{"what": "good", "evidence": "step 5"}, {"what": "", "evidence": "step 6"}], "next_focus_suggestion": "x"}',
      reasonMatch: /drifts\[1\]\.what missing or blank/,
    },
    {
      name: 'false + 建议非字符串',
      verdict: '{"on_track": false, "drifts": [{"what": "loop", "evidence": "step 5"}], "next_focus_suggestion": 42}',
      reasonMatch: /next_focus_suggestion is not a string/,
    },
    {
      name: 'true 但含偏离条目（自相矛盾）',
      verdict: '{"on_track": true, "drifts": [{"what": "loop", "evidence": "step 5"}]}',
      reasonMatch: /self-contradictory/,
    },
  ];

  for (const tc of INVALID_CASES) {
    it(`无效结果整份不投递：${tc.name}`, async () => {
      const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM(tc.verdict));

      const out = await auditor.maybeAudit(defaultReq());
      expect(out.audited).toBe(false);
      expect(out.reason).toBe('audit_verdict_incomplete');

      // 不写 inbox、不记 drift/delivered
      const pending = await fs.readdir(inboxDir);
      expect(pending.length).toBe(0);
      const emittedTypes = auditEvents.map(e => e[0]);
      expect(emittedTypes).not.toContain('contract_audit_drift_detected');
      expect(emittedTypes).not.toContain('contract_audit_feedback_delivered');
      // 原文仍留存 + invalid 处置记录具体字段问题
      expect(emittedTypes).toContain('contract_audit_result_recorded');
      const dispositions = eventsOf(auditEvents, 'contract_audit_feedback_disposition');
      expect(dispositions.length).toBe(1);
      expect(colValue(dispositions[0]!.slice(1), 'disposition')).toBe('invalid');
      expect(colValue(dispositions[0]!.slice(1), 'reasons')).toMatch(tc.reasonMatch);
    });
  }

  it('无效结果不删除已有有效 pending 反馈（副作用在有效性门之后）', async () => {
    // 先投递一条有效反馈（新实例避开限流）
    const { auditor: a1 } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "valid drift", "evidence": "step 10"}], "next_focus_suggestion": "fix"}',
    ));
    await a1.maybeAudit(defaultReq({ currentStep: 50 }));
    let pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(1);
    const validFile = pending[0]!;

    // 无效结果到来：不删旧 pending、不写新文件
    const { auditor: a2, auditEvents } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "", "evidence": ""}]}',
    ));
    const out = await a2.maybeAudit(defaultReq({ currentStep: 100 }));
    expect(out.audited).toBe(false);
    pending = await fs.readdir(inboxDir);
    expect(pending).toEqual([validFile]);
    const content = await fs.readFile(path.join(inboxDir, validFile), 'utf-8');
    expect(content).toContain('valid drift');
    expect(colValue(eventsOf(auditEvents, 'contract_audit_feedback_disposition')[0]!.slice(1), 'disposition')).toBe('invalid');
  });

  it('缺建议的完整结果仍可投递，正文省略建议节', async () => {
    const { auditor } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "loop", "evidence": "step 5"}]}',
    ));
    const out = await auditor.maybeAudit(defaultReq());
    expect(out.audited).toBe(true);

    const pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(1);
    const content = await fs.readFile(path.join(inboxDir, pending[0]!), 'utf-8');
    expect(content).toContain('loop');
    expect(content).toContain('step 5');
    expect(content).not.toContain('建议：');
  });

  it('限流：30s 内第二次有效反馈记 rate_limited、不删旧 pending', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "A", "evidence": "step 50"}], "next_focus_suggestion": "x"}',
    ));
    await auditor.maybeAudit(defaultReq({ currentStep: 50 }));
    let pending = await fs.readdir(inboxDir);
    expect(pending.length).toBe(1);
    const firstFile = pending[0]!;

    // 同 auditor 实例（lastDeliveredBySender 仍在 30s 窗口内）
    const out = await auditor.maybeAudit(defaultReq({ currentStep: 100, lastAuditedStep: 50 }));
    expect(out.audited).toBe(true);
    pending = await fs.readdir(inboxDir);
    expect(pending).toEqual([firstFile]);
    const dispositions = eventsOf(auditEvents, 'contract_audit_feedback_disposition');
    expect(dispositions.map(d => colValue(d.slice(1), 'disposition'))).toEqual(['delivered', 'rate_limited']);
  });

  it('removePendingBySource 失败：记 remove_pending_failed、不记 delivered、错误传播', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "A", "evidence": "step 50"}]}',
    ));
    const boom = new Error('EIO remove');
    const origRemove = inbox.removePendingBySource.bind(inbox);
    inbox.removePendingBySource = async (source: string) => { void origRemove; void source; throw boom; };

    await expect(auditor.maybeAudit(defaultReq())).rejects.toThrow('EIO remove');
    const dispositions = eventsOf(auditEvents, 'contract_audit_feedback_disposition');
    expect(dispositions.length).toBe(1);
    expect(colValue(dispositions[0]!.slice(1), 'disposition')).toBe('remove_pending_failed');
    expect(colValue(dispositions[0]!.slice(1), 'error')).toContain('EIO remove');
    expect(auditEvents.map(e => e[0])).not.toContain('contract_audit_feedback_delivered');
  });

  it('inbox.write 失败：记 write_failed、不记 delivered、错误传播', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM(
      '{"on_track": false, "drifts": [{"what": "A", "evidence": "step 50"}]}',
    ));
    const boom = new Error('ENOSPC write');
    inbox.write = async () => { throw boom; };

    await expect(auditor.maybeAudit(defaultReq())).rejects.toThrow('ENOSPC write');
    const dispositions = eventsOf(auditEvents, 'contract_audit_feedback_disposition');
    expect(dispositions.length).toBe(1);
    expect(colValue(dispositions[0]!.slice(1), 'disposition')).toBe('write_failed');
    expect(auditEvents.map(e => e[0])).not.toContain('contract_audit_feedback_delivered');
  });

  it('LLM 抛错：记 llm_call_failed（含 disposition）、不伪造 raw response 记录', async () => {
    const { auditor, auditEvents } = makeAuditorAndAudit(makeThrowingLLM(new Error('network down')));

    const out = await auditor.maybeAudit(defaultReq());
    expect(out.audited).toBe(false);
    expect(out.reason).toMatch(/^llm_call_failed:/);

    const emittedTypes = auditEvents.map(e => e[0]);
    expect(emittedTypes).not.toContain('contract_audit_result_recorded');
    const dispositions = eventsOf(auditEvents, 'contract_audit_feedback_disposition');
    expect(dispositions.length).toBe(1);
    expect(colValue(dispositions[0]!.slice(1), 'disposition')).toBe('llm_call_failed');
    expect(colValue(dispositions[0]!.slice(1), 'error')).toContain('network down');
  });

  it('非法 JSON / 非布尔 on_track：记 parse_failed，不归为 llm_call_failed', async () => {
    for (const bad of ['not json at all', '{"on_track": "yes", "drifts": []}', '[1,2,3]']) {
      const { auditor, auditEvents } = makeAuditorAndAudit(makeMockLLM(bad));
      const out = await auditor.maybeAudit(defaultReq());
      expect(out.audited).toBe(false);
      expect(out.reason).toMatch(/^parse_failed:/);
      expect(out.reason).not.toContain('llm_call_failed');
      // 有响应 ⇒ 原文已先留存；解析失败有独立处置
      expect(auditEvents.map(e => e[0])).toContain('contract_audit_result_recorded');
      const dispositions = eventsOf(auditEvents, 'contract_audit_feedback_disposition');
      expect(dispositions.length).toBe(1);
      expect(colValue(dispositions[0]!.slice(1), 'disposition')).toBe('parse_failed');
      const pending = await fs.readdir(inboxDir);
      expect(pending.length).toBe(0);
    }
  });

  it('footprint 读取失败：记 footprint_failed 阶段与原错误', async () => {
    const auditCtx = makeAudit();
    const throwingFs = {
      read: async () => { throw new Error('EACCES audit.tsv'); },
    } as unknown as FileSystem;
    const inboxAudit = makeAudit();
    inbox = InboxWriter.__internal_create(nfs, makeInboxPath('inbox/pending'), inboxAudit.audit, MESSAGING_WRITER_LIMITS_DEFAULT);
    const auditor = new ContractAuditor({
      audit: auditCtx.audit,
      fs: throwingFs,
      inbox,
      llm: makeMockLLM('{"on_track": true, "drifts": []}'),
    });

    const out = await auditor.maybeAudit(defaultReq());
    expect(out.audited).toBe(false);
    expect(out.reason).toMatch(/^footprint_read_failed:/);
    const dispositions = eventsOf(auditCtx.events, 'contract_audit_feedback_disposition');
    expect(dispositions.length).toBe(1);
    expect(colValue(dispositions[0]!.slice(1), 'disposition')).toBe('footprint_failed');
    expect(colValue(dispositions[0]!.slice(1), 'error')).toContain('EACCES audit.tsv');
  });
});
