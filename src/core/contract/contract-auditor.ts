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
 * phase 1830: 有效性门 + 处置审计链。LLM 原始返回（含非文本 block）与实际 prompt 先经
 * CONTRACT_AUDIT_RESULT_RECORDED 留 audit（reviewId 关联），再解析分类；不完整结果
 * （空 drifts / 条目缺 what 或 evidence / 建议非字符串 / 自相矛盾）整份不投递、不删旧
 * pending 反馈，只留 disposition 审计。限流/删除/写入各自捕获并记真实阶段，不混称
 * llm_call_failed；只有 inbox.write 成功才记 delivered。
 *
 * Philosophy align：「系统在智能体需要决策时交付相关信息」+「事件驱动」+「agent 是决策主体」（auditor 仅 surface 事实、不替决策）
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr, newUuid } from "../../foundation/node-utils/index.js";
import type { FileSystem } from '../../foundation/fs/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { InboxWriter } from '../../foundation/messaging/index.js';
import type { ContentBlock, LLMResponse, TextBlock } from '../../foundation/llm-provider/index.js';
import { buildAuditorPrompt } from './auditor-prompt.js';
import { contractAuditDriftLine, contractAuditFeedbackBody } from '../../templates/messages/index.js';
import { contractFootprint, type ContractFootprint, type ContractFootprintOptions } from './contract-footprint.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import type { ClawId } from '../../foundation/claw-identity/index.js';

/**
 * Default `maxOutputTokens` for contract auditor LLM verdict call.
 * Derivation: 1024 token ≈ 768 中文字符 / 足够 JSON verdict {on_track, drifts, next_focus} + 留 jitter / 不浪费 token budget.
 */
const DEFAULT_AUDITOR_MAX_OUTPUT_TOKENS = 1024;

interface AuditorDrift {
  what: string;
  evidence: string;
}

interface AuditorVerdict {
  on_track: boolean;
  drifts: AuditorDrift[];
  next_focus_suggestion: string;
}

/**
 * phase 1830: 解析结果 = verdict + 逐条结构问题。
 * issues 非空时整份结果不可投递（不静默过滤后呈现部分结论）。
 */
interface ParsedVerdict {
  verdict: AuditorVerdict;
  issues: string[];
}

/**
 * phase 1830: owner 侧有效性分类（有效性=结构与依据字段完整性，不验证模型证据真伪）。
 */
type FeedbackDisposition =
  | { kind: 'on_track' }
  | { kind: 'invalid'; reasons: string[] }
  | { kind: 'feedback'; verdict: AuditorVerdict };

interface ContractAuditorDeps {
  audit: AuditLog;
  fs: FileSystem;
  inbox: InboxWriter;
  llm: LLMOrchestrator;
  /** auditor LLM 最大 token 输出. Default: {@link DEFAULT_AUDITOR_MAX_OUTPUT_TOKENS} */
  maxOutputTokens?: number;
}

interface AuditRequest {
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

interface AuditOutcome {
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
    // phase 1830: 每次审阅独立 reviewId（UUID；进程重启不碰撞），贯穿结果记录与处置链
    const reviewId = newUuid();

    this.deps.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_TRIGGERED,
      `contractId=${req.contractId}`,
      `clawId=${req.clawId}`,
      `step=${req.currentStep}`,
      `reviewId=${reviewId}`,
    );

    const sinceTimestampMs = req.contractStartedAt
      ? Date.parse(req.contractStartedAt) || 0
      : 0;
    const fpOpts: ContractFootprintOptions = {
      sinceTimestampMs,
      recentExecN: 50,
    };
    let fp: ContractFootprint;
    try {
      fp = await contractFootprint(this.deps.fs, req.contractId, fpOpts);
    } catch (err) {
      // phase 1830: footprint 读取失败保留阶段与原错误（不依赖 manager 空 catch 留证）
      const reason = formatErr(err);
      this.writeDisposition(reviewId, req, 'footprint_failed', `error=${reason}`);
      return { audited: false, reason: `footprint_read_failed:${reason}` };
    }

    // 材料采集时刻：footprint + progress 已就位、prompt 构造前由 owner 捕获
    const collectedAt = new Date().toISOString();
    const prompt = buildAuditorPrompt({
      contractId: req.contractId,
      contractTitle: req.contractTitle,
      expectations: req.expectations!,  // maybeAudit 已 guard !expectations、_doAudit 进入时必非 undefined
      progress: req.progress,
      footprint: fp,
      recentMessages: req.recentMessages,
    });

    let response: LLMResponse;
    try {
      response = await this.callAuditorLLM(prompt);
    } catch (err) {
      const reason = formatErr(err);
      this.deps.audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_TRIGGERED,
        `contractId=${req.contractId}`,
        `step=${req.currentStep}`,
        `llm_call_failed=${reason}`,
        `reviewId=${reviewId}`,
      );
      this.writeDisposition(reviewId, req, 'llm_call_failed', `error=${reason}`);
      return { audited: false, reason: `llm_call_failed:${reason}` };
    }

    // phase 1830: 先留存完整原始返回（含非文本 content block）+ 实际 prompt + 身份/采集时刻，
    // JSON 一次编码交 AuditLog 转义；不双重手工转义、不经 preview/message/summary 截断。
    this.deps.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_RESULT_RECORDED,
      `reviewId=${reviewId}`,
      `contractId=${req.contractId}`,
      `payload=${JSON.stringify({
        reviewId,
        contractId: req.contractId,
        contractTitle: req.contractTitle,
        clawId: req.clawId,
        currentStep: req.currentStep,
        collectedAt,
        prompt,
        response,
      })}`,
    );

    let parsed: ParsedVerdict;
    try {
      parsed = parseVerdictDetailed(extractText(response.content));
    } catch (err) {
      // 解析/结构失败与 LLM 调用失败分开记录，不混称 llm_call_failed
      const reason = formatErr(err);
      this.writeDisposition(reviewId, req, 'parse_failed', `error=${reason}`);
      return { audited: false, reason: `parse_failed:${reason}` };
    }

    const disposition = classifyVerdict(parsed);
    if (disposition.kind === 'on_track') {
      this.writeDisposition(reviewId, req, 'on_track');
      return { audited: true, verdict: parsed.verdict };
    }
    if (disposition.kind === 'invalid') {
      // 不完整结果：整份不投递、不进入限流/删除/写入，只留处置记录
      this.writeDisposition(reviewId, req, 'invalid', `reasons=${JSON.stringify(disposition.reasons)}`);
      return { audited: false, verdict: parsed.verdict, reason: 'audit_verdict_incomplete' };
    }

    // 完整有依据的偏离结果才进入既有投递链
    this.deps.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_DRIFT_DETECTED,
      `contractId=${req.contractId}`,
      `clawId=${req.clawId}`,
      `step=${req.currentStep}`,
      `drifts=${disposition.verdict.drifts.length}`,
      `reviewId=${reviewId}`,
    );
    await this.deliverFeedback(req, disposition.verdict, reviewId, collectedAt);
    return { audited: true, verdict: disposition.verdict };
  }

  /** LLM 调用边界：只负责拿原始 response；解析在 _doAudit 内单独阶段。 */
  private async callAuditorLLM(prompt: string): Promise<LLMResponse> {
    const response = await this.deps.llm.call({
      messages: [{ role: 'user', content: prompt }],
      system: AUDITOR_SYSTEM_PROMPT,
      maxTokens: this.deps.maxOutputTokens ?? DEFAULT_AUDITOR_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      signal: this.abortController.signal,  // phase 517 B3: dispose 时 abort in-flight LLM
    });
    return response;
  }

  /** phase 1830: 处置链审计（reviewId 关联 RESULT_RECORDED 原文记录）。 */
  private writeDisposition(reviewId: string, req: AuditRequest, disposition: string, ...extra: string[]): void {
    this.deps.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_FEEDBACK_DISPOSITION,
      `reviewId=${reviewId}`,
      `contractId=${req.contractId}`,
      `step=${req.currentStep}`,
      `disposition=${disposition}`,
      ...extra,
    );
  }

  private async deliverFeedback(req: AuditRequest, verdict: AuditorVerdict, reviewId: string, collectedAt: string): Promise<void> {
    const sender = `contract-auditor-${req.contractId}`;
    const nowMs = Date.now();
    const last = this.lastDeliveredBySender.get(sender) ?? 0;
    if (nowMs - last < this.minDeliveryIntervalMs) {
      // 限流：上次投递距今 < 30s、跳过本次（避免短期重复打扰）；不删除旧 pending
      this.writeDisposition(reviewId, req, 'rate_limited', `sender=${sender}`);
      return;
    }

    // 去重：删 pending 中同 sender 旧消息（失败记真实阶段、不记 delivered）
    try {
      await this.deps.inbox.removePendingBySource(sender);
    } catch (err) {
      this.writeDisposition(reviewId, req, 'remove_pending_failed', `error=${formatErr(err)}`);
      throw err;
    }

    const driftLines = verdict.drifts
      .map((d, i) => contractAuditDriftLine(i, d.what, d.evidence))
      .join('\n');
    const body = contractAuditFeedbackBody({
      contractId: req.contractId,
      contractTitle: req.contractTitle,
      driftLines,
      suggestion: verdict.next_focus_suggestion,
      includesRecentMessages: typeof req.recentMessages === 'string' && req.recentMessages.length > 0,
      collectedAt,
    });

    try {
      await this.deps.inbox.write({
        id: `auditor-${req.contractId}-${nowMs}`,
        type: 'contract_audit_feedback',
        from: sender,
        to: req.clawId,
        content: body,
        priority: 'high',
        timestamp: new Date(nowMs).toISOString(),
      });
    } catch (err) {
      this.writeDisposition(reviewId, req, 'write_failed', `error=${formatErr(err)}`);
      throw err;
    }

    this.lastDeliveredBySender.set(sender, nowMs);
    this.deps.audit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_AUDIT_FEEDBACK_DELIVERED,
      `contractId=${req.contractId}`,
      `clawId=${req.clawId}`,
      `step=${req.currentStep}`,
      `drifts=${verdict.drifts.length}`,
      `reviewId=${reviewId}`,
    );
    this.writeDisposition(reviewId, req, 'delivered');
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
 * phase 1830: 不再静默过滤条目——逐条 what/evidence 完整性问题经 parseVerdictDetailed
 * 的 issues 上抛给 owner 分类；本入口只返回 verdict 部分（保持既有导出契约）。
 */
export function parseVerdict(rawText: string): AuditorVerdict {
  return parseVerdictDetailed(rawText).verdict;
}

/**
 * phase 1830: 完整解析入口 — verdict + 逐条结构问题。
 * 所有条目都检查（不以第一条有效放过后续非法条目）；what/evidence 用 trim 判空、
 * 呈现保留原文本；next_focus_suggestion 缺省/空字符串合法，非字符串记结构问题。
 * 抛出 = 解析/根结构失败（非 JSON、on_track 非布尔、根节点非法）。
 */
function parseVerdictDetailed(rawText: string): ParsedVerdict {
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

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('auditor response is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.on_track !== 'boolean') {
    throw new Error('on_track field missing or not boolean');
  }

  const issues: string[] = [];
  const drifts: AuditorDrift[] = [];
  if (obj.drifts !== undefined && !Array.isArray(obj.drifts)) {
    issues.push('drifts field is not an array');
  } else if (Array.isArray(obj.drifts)) {
    obj.drifts.forEach((d, i) => {
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        issues.push(`drifts[${i}] is not an object`);
        return;
      }
      const dd = d as Record<string, unknown>;
      const what = typeof dd.what === 'string' ? dd.what : '';
      const evidence = typeof dd.evidence === 'string' ? dd.evidence : '';
      if (!what.trim()) {
        issues.push(`drifts[${i}].what missing or blank`);
        return;
      }
      if (!evidence.trim()) {
        issues.push(`drifts[${i}].evidence missing or blank`);
        return;
      }
      drifts.push({ what, evidence });
    });
  }

  let next_focus_suggestion = '';
  if (obj.next_focus_suggestion !== undefined) {
    if (typeof obj.next_focus_suggestion === 'string') {
      next_focus_suggestion = obj.next_focus_suggestion;
    } else {
      issues.push('next_focus_suggestion is not a string');
    }
  }

  return {
    verdict: {
      on_track: obj.on_track,
      drifts,
      next_focus_suggestion,
    },
    issues,
  };
}

/**
 * phase 1830: 有效性分类 — 结构与依据字段完整性判定（不验证模型证据真伪、不二次模型裁决）。
 * - 任一结构问题 → invalid 整份不投递（混合也不悄悄过滤后呈现部分结论）
 * - on_track=true 但含偏离条目 → 自相矛盾，不投递也不宣称已确认 on_track
 * - on_track=false 但无有效偏离条目 → 无依据，不投递
 */
function classifyVerdict(parsed: ParsedVerdict): FeedbackDisposition {
  const { verdict, issues } = parsed;
  if (issues.length > 0) {
    return { kind: 'invalid', reasons: issues };
  }
  if (verdict.on_track) {
    if (verdict.drifts.length > 0) {
      return { kind: 'invalid', reasons: ['on_track=true but drifts non-empty (self-contradictory)'] };
    }
    return { kind: 'on_track' };
  }
  if (verdict.drifts.length === 0) {
    return { kind: 'invalid', reasons: ['on_track=false but no valid drift entries'] };
  }
  return { kind: 'feedback', verdict };
}
