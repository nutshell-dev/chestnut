/**
 * @module L4.ContractSystem
 * phase 1424: contract auditor — 周期 LLM 对照 contract.expectations 检查 claw 行为 + inbox 高优反馈
 *
 * 触发：ContractSystem.maybeAuditStep(currentStep) 调（来自 Runtime.onStepComplete 钩子）
 * 输入：contractFootprint(audit, contractId, opts) + contract.expectations + progress.json
 * 判定：LLM call 返 JSON { on_track, drifts, next_focus_suggestion }
 * 反馈：on_track=false 时 inbox.write({ priority:'high', from:`contract-auditor-${contractId}`, ... })
 * 去重：同 from sender 的 pending 消息先删（保最新）/ 防连续 stuck 时刷屏
 *
 * 复用：PriorityInboxInterrupt 路径（runtime.ts:565-567）— 0 新中断 API、0 partial state 风险
 *
 * Philosophy align：「系统在智能体需要决策时交付相关信息」+「事件驱动」+「agent 是决策主体」（auditor 仅 surface 事实、不替决策）
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from "../../foundation/utils/index.js";
import type { FileSystem } from '../../foundation/fs/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { InboxWriter } from '../../foundation/messaging/index.js';
import type { ContentBlock, TextBlock } from '../../foundation/llm-provider/index.js';
import { buildAuditorPrompt } from './auditor-prompt.js';
import { contractFootprint, type ContractFootprintOptions } from './contract-footprint.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import type { ClawId } from '../../foundation/identity/index.js';

/**
 * Default `maxOutputTokens` for contract auditor LLM verdict call.
 * Derivation: 1024 token ≈ 768 中文字符 / 足够 JSON verdict {on_track, drifts, next_focus} + 留 jitter / 不浪费 token budget.
 */
const DEFAULT_AUDITOR_MAX_OUTPUT_TOKENS = 1024;

export interface AuditorDrift {
  what: string;
  evidence: string;
}

export interface AuditorVerdict {
  on_track: boolean;
  drifts: AuditorDrift[];
  next_focus_suggestion: string;
}

export interface ContractAuditorDeps {
  audit: AuditLog;
  fs: FileSystem;
  inbox: InboxWriter;
  llm: LLMOrchestrator;
  /** inbox pending dir 绝对路径（用于去重 list + delete） */
  inboxPendingDir: string;
  /** auditor LLM 最大 token 输出. Default: {@link DEFAULT_AUDITOR_MAX_OUTPUT_TOKENS} */
  maxOutputTokens?: number;
}

export interface AuditRequest {
  contractId: string;
  contractTitle: string;
  clawId: ClawId;
  /** ReAct 步数（来自 ctx.stepNumber） */
  currentStep: number;
  /** audit_interval（contract.yaml 配置、0=disable） */
  auditInterval: number;
  /** 上次 audit 的 currentStep（同 contract 内单调） */
  lastAuditedStep: number;
  /** contract.expectations 文本（缺省 undefined → 不审） */
  expectations: string | undefined;
  /** contract.started_at ISO 时间戳（filter audit.tsv 用） */
  contractStartedAt: string | undefined;
  progress: {
    done: string[];
    in_progress: string | null;
    pending: string[];
  };
  /** 最近 dialog reasoning（可选、auditor 输入用） */
  recentMessages?: string;
}

export interface AuditOutcome {
  audited: boolean;
  verdict?: AuditorVerdict;
  reason?: string;  // skip 原因（audited=false 时）
}

const AUDITOR_SYSTEM_PROMPT = `You are a contract auditor for an autonomous AI agent. Read recent activity, compare to contract expectations, and report either "on_track" or specific drifts. Output strict JSON only.`;

/**
 * Contract Auditor — 周期调度 + LLM 调用 + drift 反馈投递
 */
export class ContractAuditor {
  private readonly deps: ContractAuditorDeps;
  /** 同 from sender 限流：最近一次投递时间（防连续 drift 时 inbox 刷屏） */
  private readonly lastDeliveredBySender = new Map<string, number>();
  /** 最少投递间隔（ms）：30s（短期反馈合并） */
  private readonly minDeliveryIntervalMs = 30_000;
  /** phase 517 B3: AbortController 中断 in-flight LLM call（SIGTERM / dispose 路径）*/
  private abortController = new AbortController();
  /** phase 517 B3: closed 后拒绝新 maybeAudit、保 inflight 计数 + 等待 settle */
  private closed = false;
  private inflightPromises = new Set<Promise<unknown>>();

  constructor(deps: ContractAuditorDeps) {
    this.deps = deps;
  }

  /**
   * 主入口：ContractSystem 在 step counter 滴答时调
   * 若 currentStep - lastAuditedStep >= auditInterval 则跑 audit
   */
  async maybeAudit(req: AuditRequest): Promise<AuditOutcome> {
    // phase 517 B3: closed 后拒绝新 audit（防 dispose 期间又触发新 LLM call）
    if (this.closed) {
      return { audited: false, reason: 'auditor_closed' };
    }
    if (req.auditInterval <= 0) {
      return { audited: false, reason: 'audit_interval_disabled' };
    }
    if (req.currentStep - req.lastAuditedStep < req.auditInterval) {
      return { audited: false, reason: 'interval_not_reached' };
    }
    if (!req.expectations) {
      return { audited: false, reason: 'no_expectations' };
    }

    // phase 517 B3: 追 inflight、close 时 await 所有 settle
    const work = this._doAudit(req);
    this.inflightPromises.add(work);
    try {
      return await work;
    } finally {
      this.inflightPromises.delete(work);
    }
  }

  private async _doAudit(req: AuditRequest): Promise<AuditOutcome> {

    this.deps.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_TRIGGERED,
      `contractId=${req.contractId}`,
      `clawId=${req.clawId}`,
      `step=${req.currentStep}`,
    );

    const sinceTimestampMs = req.contractStartedAt
      ? Date.parse(req.contractStartedAt) || 0
      : 0;
    const fpOpts: ContractFootprintOptions = {
      sinceTimestampMs,
      recentExecN: 50,
    };
    const fp = await contractFootprint(this.deps.fs, req.contractId, fpOpts);

    const prompt = buildAuditorPrompt({
      contractId: req.contractId,
      contractTitle: req.contractTitle,
      expectations: req.expectations!,  // maybeAudit 已 guard !expectations、_doAudit 进入时必非 undefined
      progress: req.progress,
      footprint: fp,
      recentMessages: req.recentMessages,
    });

    let verdict: AuditorVerdict;
    try {
      verdict = await this.callAuditorLLM(prompt);
    } catch (err) {
      const reason = formatErr(err);
      this.deps.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_TRIGGERED,
        `contractId=${req.contractId}`,
        `step=${req.currentStep}`,
        `llm_call_failed=${reason}`,
      );
      return { audited: false, reason: `llm_call_failed:${reason}` };
    }

    if (!verdict.on_track) {
      this.deps.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_DRIFT_DETECTED,
        `contractId=${req.contractId}`,
        `clawId=${req.clawId}`,
        `step=${req.currentStep}`,
        `drifts=${verdict.drifts.length}`,
      );
      await this.deliverFeedback(req, verdict);
    }

    return { audited: true, verdict };
  }

  private async callAuditorLLM(prompt: string): Promise<AuditorVerdict> {
    const response = await this.deps.llm.call({
      messages: [{ role: 'user', content: prompt }],
      system: AUDITOR_SYSTEM_PROMPT,
      maxTokens: this.deps.maxOutputTokens ?? DEFAULT_AUDITOR_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      signal: this.abortController.signal,  // phase 517 B3: dispose 时 abort in-flight LLM
    });
    const text = extractText(response.content);
    const verdict = parseVerdict(text);
    return verdict;
  }

  private async deliverFeedback(req: AuditRequest, verdict: AuditorVerdict): Promise<void> {
    const sender = `contract-auditor-${req.contractId}`;
    const nowMs = Date.now();
    const last = this.lastDeliveredBySender.get(sender) ?? 0;
    if (nowMs - last < this.minDeliveryIntervalMs) {
      // 限流：上次投递距今 < 30s、跳过本次（避免短期重复打扰）
      return;
    }

    // 去重：删 pending 中同 sender 旧消息
    await this.removeStaleAuditorMessages(sender);

    const driftLines = verdict.drifts.map((d, i) => `${i + 1}. ${d.what}（证据：${d.evidence}）`).join('\n');
    const body = `看了你最近的活动，几个点：

${driftLines || '（auditor 标 drift 但未给具体条目）'}

建议：${verdict.next_focus_suggestion || '（无）'}`;

    await this.deps.inbox.write({
      id: `auditor-${req.contractId}-${nowMs}`,
      type: 'contract_audit_feedback',
      from: sender,
      to: req.clawId,
      content: body,
      priority: 'high',
      timestamp: new Date(nowMs).toISOString(),
    });

    this.lastDeliveredBySender.set(sender, nowMs);
    this.deps.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_FEEDBACK_DELIVERED,
      `contractId=${req.contractId}`,
      `clawId=${req.clawId}`,
      `step=${req.currentStep}`,
      `drifts=${verdict.drifts.length}`,
    );
  }

  private async removeStaleAuditorMessages(sender: string): Promise<void> {
    let entries: { name: string }[];
    try {
      entries = await this.deps.fs.list(this.deps.inboxPendingDir, { includeDirs: false });
    } catch {
      return;  // pending dir 不存在或 list 失败，无需清理
    }
    // inbox 文件名格式 ${source}-${timestamp}_${priority}_${uuid8}.md（详 inbox-writer.ts:62）
    const prefix = `${sender}-`;
    for (const e of entries) {
      if (!e.name.startsWith(prefix)) continue;
      try {
        await this.deps.fs.delete(`${this.deps.inboxPendingDir}/${e.name}`);
      } catch {
        // silent: dedup best-effort / 删失败时 agent 见 stale+new 两条不致灾、不重要到 audit
      }
    }
  }

  /**
   * phase 517 B3: graceful dispose for shutdown path.
   * 1. 标 closed、后续 maybeAudit 直接拒绝（reason='auditor_closed'）
   * 2. abort in-flight LLM call（callAuditorLLM 用 signal、provider 收到 abort 抛 AbortError）
   * 3. await 所有 inflight settle（异常路径也 settle、用 allSettled 兜底）
   *
   * 调用方：ContractManager.close 内 await（manager.ts:1048-1065）。
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abortController.abort();
    await Promise.allSettled(Array.from(this.inflightPromises));
  }
}

function extractText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push((block as TextBlock).text);
  }
  return parts.join('\n');
}

/**
 * Parse auditor LLM JSON output.
 * 容错：尝试提取大括号包围段落 + JSON.parse + schema 基本校验。
 * 解析失败抛 Error / caller 由 try/catch 兜底。
 */
export function parseVerdict(rawText: string): AuditorVerdict {
  const trimmed = rawText.trim();
  // 兼容 LLM 可能加 markdown code fence
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // 尝试找第一个 {...} 段
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON object found in auditor response');
    parsed = JSON.parse(match[0]);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('auditor response is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.on_track !== 'boolean') {
    throw new Error('on_track field missing or not boolean');
  }
  const drifts: AuditorDrift[] = [];
  if (Array.isArray(obj.drifts)) {
    for (const d of obj.drifts) {
      if (!d || typeof d !== 'object') continue;
      const dd = d as Record<string, unknown>;
      const what = typeof dd.what === 'string' ? dd.what : '';
      const evidence = typeof dd.evidence === 'string' ? dd.evidence : '';
      if (what) drifts.push({ what, evidence });
    }
  }
  const next_focus_suggestion = typeof obj.next_focus_suggestion === 'string'
    ? obj.next_focus_suggestion
    : '';

  return {
    on_track: obj.on_track,
    drifts,
    next_focus_suggestion,
  };
}
