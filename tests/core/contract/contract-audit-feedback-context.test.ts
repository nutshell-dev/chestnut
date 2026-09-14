/**
 * phase 1830 Step B: 契约审阅反馈最终可见正文 + 真实审计记录往返。
 *
 * 链路：真实 ContractAuditor + 临时 FS 真实落盘 inbox → decodeInbox →
 * 真实 Runtime.formatInboxMessage（真实 registry 声明）→ sanitizeForLLMCall
 * （provider 边界投影）。审计侧用真实 AuditWriter 落 audit.tsv、真实
 * createAuditReader 读回，证明完整 response（含非文本 content block、制表符、
 * 换行、超 500 字文本）与实际 prompt 未经摘要截断可还原，处置链 reviewId 可关联。
 *
 * 反向三项：①模板只呈现 owner 选定事实、不判业务有效性（模板无解析/查询入参）；
 * ②无依据结果不产生占位消息、不静默过滤条目、阶段错误不混称网络失败；
 * ③从实际最终 content 与审计证据核消息与原结果一致。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { ContractAuditor } from '../../../src/core/contract/contract-auditor.js';
import { InboxWriter, makeInboxPath, MESSAGING_WRITER_LIMITS_DEFAULT } from '../../../src/foundation/messaging/index.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import {
  createInboxMessageTypeRegistry,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import { CONTRACT_INBOX_MESSAGE_TYPES } from '../../../src/core/contract/index.js';
import { createAuditWriter } from '../../../src/foundation/audit/index.js';
import { Runtime } from '../../../src/core/runtime/runtime.js';
import { sanitizeForLLMCall } from '../../../src/foundation/llm-provider/sanitize.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import type { LLMOrchestrator } from '../../../src/foundation/llm-orchestrator/index.js';
import type { LLMResponse } from '../../../src/foundation/llm-provider/types.js';

class TestRuntime extends Runtime {
  async testFormatInboxMessage(
    type: string,
    from: string,
    body: string,
    timestamp?: string,
    extraMeta?: Record<string, string>,
  ): Promise<string> {
    return this.formatInboxMessage(type, from, body, timestamp, extraMeta);
  }
}

/** 真实 Runtime（真实 formatter registry），guidance 缺省（无 guidanceCompose）。 */
function makeRuntime(audit: AuditLog): TestRuntime {
  const registry = createInboxMessageTypeRegistry();
  registerInboxMessageTypes(registry, CONTRACT_INBOX_MESSAGE_TYPES);
  return new TestRuntime({
    clawId: 'test-claw',
    clawDir: '/tmp/test-claw',
    clawsDir: '/tmp/claws',
    idleTimeoutMs: 0,
    llmConfig: {
      primary: { name: 'mock', apiKey: 'k', model: 'm', maxTokens: 1, temperature: 0, timeoutMs: 1, apiFormat: 'anthropic' as const },
      maxAttempts: 1,
      retryDelayMs: 0,
    },
    dependencies: {
      systemFs: {} as never,
      auditWriter: audit,
      snapshot: {} as never,
      sessionManager: {} as never,
      inboxReader: {} as never,
      llm: {} as never,
      toolRegistry: {
        register: vi.fn(),
        getForProfile: vi.fn().mockReturnValue([]),
        getAll: vi.fn().mockReturnValue([]),
        formatForLLM: vi.fn().mockReturnValue([]),
      } as never,
      toolExecutor: {} as never,
      contractManager: {} as never,
      taskSystem: {
        initialize: vi.fn().mockResolvedValue(undefined),
        startDispatch: vi.fn(),
        shutdown: vi.fn().mockResolvedValue({ kind: 'converged', aborted: 0, terminal: [] }),
      } as never,
      skillRegistry: {} as never,
      permissionChecker: {} as never,
      fsFactory: () => ({}) as never,
      contractNotifyCallback: undefined,
      formatterRegistry: registry,
    },
  });
}

/** provider 边界投影：Runtime 格式化结果 → sanitizeForLLMCall 后的可见 content。 */
async function providerVisibleContent(
  runtime: TestRuntime,
  msg: { type: string; from: string; content: string; createdAt?: string },
): Promise<string> {
  const formatted = await runtime.testFormatInboxMessage(msg.type, msg.from, msg.content, msg.createdAt);
  const [wire] = sanitizeForLLMCall([{ role: 'user', content: formatted }]);
  return wire.content;
}

/** 超 500 字 + 制表符 + 换行的证据文本（证明未经 summary 截断、转义可还原）。 */
const LONG_EVIDENCE = `step 40-49 重复执行 grep -r "config" .\t命中 0 次\n` +
  '补充：'.repeat(200) + '（长文本尾部标记 END-MARKER）';

function makeLLM(response: LLMResponse): LLMOrchestrator {
  return {
    async call() { return response; },
    stream: () => { throw new Error('not implemented'); },
    healthCheck: async () => true,
    getProviderInfo: () => ({ name: 'mock', model: 'mock', isFallback: false }),
    close: async () => {},
  } as LLMOrchestrator;
}

describe('phase 1830: 契约审阅反馈 → inbox → Runtime → provider + 真实审计往返', () => {
  let rootDir: string;
  let nfs: NodeFileSystem;
  let audit: AuditLog;
  let inboxDir: string;

  beforeEach(async () => {
    rootDir = await createTempDir('phase1830-audit-');
    nfs = new NodeFileSystem({ baseDir: rootDir });
    // 真实 AuditWriter 落盘（auditor footprint 也读同一 audit.tsv，同生产形态）
    audit = createAuditWriter(nfs, 'audit.tsv');
    inboxDir = path.join(rootDir, 'inbox', 'pending');
    await fs.mkdir(inboxDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(rootDir);
  });

  function makeAuditor(llm: LLMOrchestrator): ContractAuditor {
    const inbox = InboxWriter.__internal_create(
      nfs, makeInboxPath('inbox/pending'), audit, MESSAGING_WRITER_LIMITS_DEFAULT,
    );
    return new ContractAuditor({ audit, fs: nfs, inbox, llm });
  }

  function defaultReq(overrides?: Record<string, unknown>) {
    return {
      contractId: 'c-1',
      contractTitle: '修复配置重载',
      clawId: 'test-claw',
      currentStep: 50,
      auditInterval: 50,
      lastAuditedStep: 0,
      expectations: 'do X, do Y',
      contractStartedAt: undefined,
      progress: { done: [], in_progress: 's1', pending: ['s2'] },
      ...overrides,
    } as Parameters<ContractAuditor['maybeAudit']>[0];
  }

  async function readInboxMessages() {
    const files = (await fs.readdir(inboxDir)).filter(f => f.endsWith('.md'));
    const messages = [];
    for (const f of files.sort()) {
      messages.push(decodeInbox(await fs.readFile(path.join(inboxDir, f), 'utf-8')));
    }
    return messages;
  }

  interface AuditRow { type: string; cols: readonly string[] }

  /**
   * AuditWriter esc 的逆（单遍左到右解码）。
   * 不用 createAuditReader 的 unesc：其对 `\\t`/`\\n` 这类已转义序列的替换顺序
   * 会先吃掉内层反斜杠，JSON payload 无法还原（本测试要证明的恰恰是写侧无损，
   * 故用精确逆变换读回原始文件行）。
   */
  function unescCol(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const c = s[i + 1];
        if (c === '\\') { out += '\\'; i++; continue; }
        if (c === 't') { out += '\t'; i++; continue; }
        if (c === 'n') { out += '\n'; i++; continue; }
        if (c === 'r') { out += '\r'; i++; continue; }
        if (c === '0') { out += '\0'; i++; continue; }
      }
      out += s[i];
    }
    return out;
  }

  /** 读回真实 audit.tsv（写侧为生产 AuditWriter：ts \t seq \t type \t cols...）。 */
  async function readAuditRows(): Promise<AuditRow[]> {
    const content = await fs.readFile(path.join(rootDir, 'audit.tsv'), 'utf-8');
    const rows: AuditRow[] = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      rows.push({ type: unescCol(parts[2]!), cols: parts.slice(3).map(unescCol) });
    }
    return rows;
  }

  function colValue(cols: readonly string[], key: string): string | undefined {
    const hit = cols.find(c => c.startsWith(`${key}=`));
    return hit?.slice(key.length + 1);
  }

  it('有效反馈：最终 provider 可见正文自含身份/依据/建议/快照性质，审计原文完整往返', async () => {
    const verdictText = JSON.stringify({
      on_track: false,
      drifts: [{ what: '反复搜索配置但无进展', evidence: LONG_EVIDENCE }],
      next_focus_suggestion: '先提交当前改动再继续',
    });
    const response: LLMResponse = {
      content: [
        { type: 'thinking', thinking: '我先核对 expectations…', signature: 'sig-1' },
        { type: 'text', text: verdictText },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const auditor = makeAuditor(makeLLM(response));

    const out = await auditor.maybeAudit(defaultReq());
    expect(out.audited).toBe(true);

    // 最终可见正文（真实 inbox 解码 → 生产标准 formatter → provider 投影）
    const inbox = await readInboxMessages();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.type).toBe('contract_audit_feedback');
    expect(inbox[0]!.priority).toBe('high');
    const content = await providerVisibleContent(makeRuntime(audit), inbox[0]!);
    expect(content).toContain('契约执行审阅建议｜修复配置重载（c-1）');
    expect(content).toContain('反复搜索配置但无进展');
    expect(content).toContain(LONG_EVIDENCE);  // 完整依据、不截断
    expect(content).toContain('建议：先提交当前改动再继续');
    expect(content).toContain('可能的偏离');
    expect(content).toContain('材料采集于');
    expect(content).toContain('请结合当前进度判断');
    // 生产形态未传 recentMessages：不得声称看过近期对话
    expect(content).not.toContain('近期对话');
    // 无运行时占位
    expect(content).not.toContain('〈');
    expect(content).not.toContain('auditor 标 drift 但未给具体条目');

    // 真实审计往返：原始返回（含非文本 block）+ 实际 prompt 完整可读回
    const rows = await readAuditRows();
    const recorded = rows.find(r => r.type === 'contract_audit_result_recorded');
    expect(recorded).toBeDefined();
    const reviewId = colValue(recorded!.cols, 'reviewId');
    expect(reviewId).toBeTruthy();
    const payload = JSON.parse(colValue(recorded!.cols, 'payload')!) as {
      reviewId: string;
      contractId: string;
      contractTitle: string;
      collectedAt: string;
      currentStep: number;
      prompt: string;
      response: LLMResponse;
    };
    expect(payload.reviewId).toBe(reviewId);
    expect(payload.contractId).toBe('c-1');
    expect(payload.contractTitle).toBe('修复配置重载');
    expect(payload.currentStep).toBe(50);
    expect(typeof payload.collectedAt).toBe('string');
    expect(payload.prompt).toContain('do X, do Y');
    // 非文本 content block 保留（extractText 只是解析入口，不是唯一留存）
    expect(payload.response.content).toEqual(response.content);
    // 制表符/换行/超 500 字文本无截断还原
    const textBlock = payload.response.content.find(b => b.type === 'text');
    expect(textBlock).toBeDefined();
    expect((textBlock as { text: string }).text).toBe(verdictText);
    expect(LONG_EVIDENCE.length).toBeGreaterThan(500);
    // 内层 verdict JSON 同样完整可解析，制表符/换行/长文本无损
    const roundTripped = JSON.parse((textBlock as { text: string }).text) as {
      drifts: Array<{ what: string; evidence: string }>;
    };
    expect(roundTripped.drifts[0]!.evidence).toBe(LONG_EVIDENCE);

    // 处置链同 reviewId 可关联
    const dispositions = rows.filter(r => r.type === 'contract_audit_feedback_disposition');
    expect(dispositions).toHaveLength(1);
    expect(colValue(dispositions[0]!.cols, 'reviewId')).toBe(reviewId);
    expect(colValue(dispositions[0]!.cols, 'disposition')).toBe('delivered');
    const delivered = rows.find(r => r.type === 'contract_audit_feedback_delivered');
    expect(colValue(delivered!.cols, 'reviewId')).toBe(reviewId);
  });

  it('有 recentMessages 时来源行如实提及近期对话片段；缺标题时仅呈现 ID', async () => {
    const verdictText = JSON.stringify({
      on_track: false,
      drifts: [{ what: '偏离 A', evidence: 'step 7' }],
      next_focus_suggestion: '',
    });
    const response: LLMResponse = {
      content: [{ type: 'text', text: verdictText }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const auditor = makeAuditor(makeLLM(response));
    await auditor.maybeAudit(defaultReq({
      contractTitle: '',
      recentMessages: 'user: 先修配置\nassistant: 好',
    }));

    const inbox = await readInboxMessages();
    expect(inbox).toHaveLength(1);
    const content = await providerVisibleContent(makeRuntime(audit), inbox[0]!);
    expect(content).toContain('契约执行审阅建议｜c-1');
    expect(content).not.toContain('（c-1）');  // 无标题不重复 ID
    expect(content).toContain('近期对话片段');
    // 空建议：省略建议节、不显示占位
    expect(content).not.toContain('建议：');
  });

  it('无依据结果只留系统记录：不写 inbox、不删旧 pending，审计含原文与 invalid 处置', async () => {
    // 先落一条有效 pending 反馈
    const validResponse: LLMResponse = {
      content: [{ type: 'text', text: JSON.stringify({
        on_track: false,
        drifts: [{ what: '有效偏离', evidence: 'step 10' }],
        next_focus_suggestion: 'fix',
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    await makeAuditor(makeLLM(validResponse)).maybeAudit(defaultReq());
    let inbox = await readInboxMessages();
    expect(inbox).toHaveLength(1);

    // 无依据结果（混合有效/无效条目）：整份不投递、旧 pending 不动
    const mixedResponse: LLMResponse = {
      content: [{ type: 'text', text: JSON.stringify({
        on_track: false,
        drifts: [{ what: '有依据', evidence: 'step 20' }, { what: '缺依据', evidence: '   ' }],
        next_focus_suggestion: 'x',
      }) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const out = await makeAuditor(makeLLM(mixedResponse)).maybeAudit(defaultReq({ currentStep: 100 }));
    expect(out.audited).toBe(false);
    expect(out.reason).toBe('audit_verdict_incomplete');

    inbox = await readInboxMessages();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.content).toContain('有效偏离');  // 旧反馈仍在、未被无效结果替换

    const rows = await readAuditRows();
    const recorded = rows.filter(r => r.type === 'contract_audit_result_recorded');
    expect(recorded).toHaveLength(2);
    const invalidDisposition = rows.find(r =>
      r.type === 'contract_audit_feedback_disposition'
      && colValue(r.cols, 'disposition') === 'invalid');
    expect(invalidDisposition).toBeDefined();
    expect(colValue(invalidDisposition!.cols, 'reasons')).toContain('evidence missing or blank');
    // 混合结果未悄悄过滤后呈现：inbox 中没有第二条消息
    expect(inbox.some(m => m.content.includes('有依据'))).toBe(false);
  });
});
