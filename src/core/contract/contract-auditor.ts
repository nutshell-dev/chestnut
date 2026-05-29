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
import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { InboxWriter } from '../../foundation/messaging/inbox-writer.js';
import type { ClawId } from '../../foundation/identity/index.js';
import type { ContentBlock, TextBlock } from '../../foundation/llm-provider/types.js';
import { buildAuditorPrompt } from './auditor-prompt.js';
import { contractFootprint, type ContractFootprintOptions } from './contract-footprint.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

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
  /** auditor LLM 最大 token 输出（默 1024） */
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

  constructor(deps: ContractAuditorDeps) {
    this.deps = deps;
  }

  /**
   * 主入口：ContractSystem 在 step counter 滴答时调
   * 若 currentStep - lastAuditedStep >= auditInterval 则跑 audit
   */
  async maybeAudit(req: AuditRequest): Promise<AuditOutcome> {
    if (req.auditInterval <= 0) {
      return { audited: false, reason: 'audit_interval_disabled' };
    }
    if (req.currentStep - req.lastAuditedStep < req.auditInterval) {
      return { audited: false, reason: 'interval_not_reached' };
    }
    if (!req.expectations) {
      return { audited: false, reason: 'no_expectations' };
    }

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
      expectations: req.expectations,
      progress: req.progress,
      footprint: fp,
      recentMessages: req.recentMessages,
    });

    let verdict: AuditorVerdict;
    try {
      verdict = await this.callAuditorLLM(prompt);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
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
      maxTokens: this.deps.maxOutputTokens ?? 1024,
      temperature: 0.2,
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
      type: 'message',
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
