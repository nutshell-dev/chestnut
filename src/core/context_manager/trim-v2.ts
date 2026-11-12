/**
 * @module L4.ContextManager.TrimV2
 * phase 1190 三层分类裁剪策略：Tier 1 不裁 / Tier 2 尽量不裁 / Tier 3 可裁。
 */

import type { ContentBlock, TextBlock, ThinkingBlock, ToolUseBlock, ToolResultBlock, InputMeasurement, InputMeterDescriptor } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import {
  classifyMessage,
  buildContextTrimSummaryMessage,
  findToolPairSafeInsertionIndex,
  type ContextTrimSummaryStats,
} from '../../foundation/dialog-store/index.js';
import { estimateMessagesTokens } from '../../foundation/llm-provider/index.js';
import { truncateUtf8Prefix } from '../../foundation/node-utils/index.js';
import { ContextInputMeasurementError } from './errors.js';
import {
  CONTEXT_TRIM_STARTED,
  CONTEXT_TRIM_COMPLETED,
} from './audit-events.js';
import {
  CONTEXT_TRIM_TARGET_RATIO,
  REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
} from './constants.js';

export type AuditWriter = { write(event: string, ...details: string[]): void };

type TrimCandidateOutcome =
  | {
      status: 'target_reached' | 'progress';
      before: number;
      after: number;
      newMessages: Message[];
    }
  | {
      status: 'no_progress';
      before: number;
      after: number;
      reason: 'already_within_target' | 'transform_did_not_reduce';
      newMessages: Message[];
    }
  | {
      status: 'policy_conflict';
      before: number;
      after: number;
      floor: number;
      ceiling: number;
      reason: 'empty_legal_interval' | 'atomic_turn_boundary' | 'fixed_context_exceeds_ceiling';
      newMessages: Message[];
    };

export type ContextTrimOutcome =
  | (Extract<TrimCandidateOutcome, { status: 'target_reached' | 'progress' }> & {
      archived: true;
    })
  | (Extract<TrimCandidateOutcome, { status: 'no_progress' | 'policy_conflict' }> & {
      archived: false;
    });

export type TrimPolicy =
  | { kind: 'proactive'; targetCompleteTokens: number }
  | { kind: 'reactive'; targetCompleteTokens: number };

export interface TrimV2Options {
  recentWindowMs: number;
  previewBytes: number;
  fixedTokens: number;
  measureComplete?: (messages: readonly Message[]) => InputMeasurement;
  measurementDescriptor?: Readonly<InputMeterDescriptor>;
  policy: TrimPolicy;
  now: number;
  /** phase 1861 (CM-D3)：audit sink 必填——trim 事实不允许静默。 */
  audit: AuditWriter;
}

function completeTokens(messages: readonly Message[], opts: TrimV2Options): number {
  if (opts.measureComplete) {
    const measurement = opts.measureComplete(messages);
    if (measurement.kind === 'unavailable') {
      throw new ContextInputMeasurementError(measurement.reason, opts.measurementDescriptor);
    }
    return measurement.tokens;
  }
  return opts.fixedTokens + estimateMessagesTokens(messages);
}

interface TrimV2Result {
  outcome: TrimCandidateOutcome;
  droppedMessages: Message[];
  metrics: {
    droppedSystemMessages: number;
    collapsedToolResults: number;
    collapsedToolUseFields: number;
    supersededRedundantResults: number;
    summaryMessageInjected: boolean;
  };
}

interface CompressResult {
  messages: Message[];
  subtypeStat: SubtypeStat;
  toolStat: ToolStat;
  collapsedSystemMessages: number;
  collapsedToolResults: number;
  collapsedToolUseFields: number;
  collapsedTextBlocks: number;
  collapsedThinkingBlocks: number;
  supersededRedundantResults: number;
  /** 在 proactive 场景下，摘要应插入此位置（处理过的 target 消息之后、未处理的非 target 消息之前）。reactive 时为 messages.length。 */
  boundaryIndex: number;
}

type SubtypeStat = ContextTrimSummaryStats['subtypeStat'];
type ToolStat = ContextTrimSummaryStats['toolStat'];

/** 构造 reactive 裁剪策略：完整 prompt 必须落在 [floor, ceiling]。 */
export function buildReactiveTrimPolicy(
  input: {
    contextWindow: number;
    explicitMaxTokens: number | undefined;
  },
  opts?: { targetRatio?: number },
): Extract<TrimPolicy, { kind: 'reactive' }> {
  // maxTokens 是输出预算，不参与本阶段上下文裁剪目标；目标只由
  // reactive target ratio 决定，避免“窗口−最大输出 token”改变裁剪语义。
  void input.explicitMaxTokens;
  const targetRatio = opts?.targetRatio ?? REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO;
  return {
    kind: 'reactive',
    targetCompleteTokens: Math.floor(input.contextWindow * targetRatio),
  };
}

/** 构造 proactive 顺手裁策略：消息历史目标上限。 */
export function buildProactiveTrimPolicy(
  contextWindow: number,
  opts?: { targetRatio?: number },
): Extract<TrimPolicy, { kind: 'proactive' }> {
  // phase 1861 (CM-D1)：target ratio 经注入面传入，常量仅为默认值。
  const targetRatio = opts?.targetRatio ?? CONTEXT_TRIM_TARGET_RATIO;
  return {
    kind: 'proactive',
    targetCompleteTokens: Math.floor(contextWindow * targetRatio),
  };
}

/**
 * phase 1190 三层分类裁剪算法。
 *
 * pure function、不涉持久化（archive + save 由 trimAndPersist orchestration 承担）。
 *
 * 输入：messages（含 metadata）+ options。
 * 输出：discriminated outcome + dropped messages + metrics。
 */
export function trimV2(messages: readonly Message[], opts: TrimV2Options): TrimV2Result {
  const before = completeTokens(messages, opts);

  const targetLabel =
    opts.policy.kind === 'proactive'
      ? `target=${opts.policy.targetCompleteTokens}`
      : `target=${opts.policy.targetCompleteTokens}`;
  opts.audit.write(CONTEXT_TRIM_STARTED, `before=${before}`, `fixed=${opts.fixedTokens}`, targetLabel);

  let result: TrimV2Result;

  const targetTokens = opts.policy.kind === 'proactive'
    ? opts.policy.targetCompleteTokens
    : opts.policy.targetCompleteTokens;
  const initialSplit = splitBy24h(messages, opts.recentWindowMs, opts.now);
  let compressed = compressSequential(
    messages,
    opts,
    opts.policy.kind === 'proactive' ? initialSplit.olderIndices : initialSplit.olderIndices,
    targetTokens,
    initialSplit.olderIndices.length,
  );
  let droppedMessages: Message[] = [];

  if (opts.policy.kind === 'proactive') {
    if (initialSplit.olderIndices.length > 0 &&
        completeTokens(compressed.messages, opts) > targetTokens) {
      const dropped = dropTurnsSelective(compressed, before, opts, {
        onlyBeforeIndex: initialSplit.olderIndices.length,
      });
      compressed = { ...compressed, messages: dropped.outcome.newMessages };
      droppedMessages = dropped.droppedMessages;
    }
  } else {
    // reactive 顺序固定为：旧缩短 → 旧移除 → 新缩短 → 新移除；每个阶段
    // 都在每个合法候选后重算完整输入，达到目标立即停止。
    if (completeTokens(compressed.messages, opts) > targetTokens) {
      const droppedOld = dropTurnsSelective(compressed, before, opts, {
        onlyBeforeIndex: initialSplit.olderIndices.length,
      });
      compressed = { ...compressed, messages: droppedOld.outcome.newMessages };
      droppedMessages.push(...droppedOld.droppedMessages);
    }
    if (completeTokens(compressed.messages, opts) > targetTokens) {
      const split = splitBy24h(compressed.messages, opts.recentWindowMs, opts.now);
      compressed = compressSequential(compressed.messages, opts, split.newerIndices, targetTokens, split.olderIndices.length);
    }
    if (completeTokens(compressed.messages, opts) > targetTokens) {
      const split = splitBy24h(compressed.messages, opts.recentWindowMs, opts.now);
      const droppedRecent = dropTurnsSelective(compressed, before, opts, {
        onlyAfterIndex: split.olderIndices.length,
      });
      compressed = { ...compressed, messages: droppedRecent.outcome.newMessages };
      droppedMessages.push(...droppedRecent.droppedMessages);
    }
  }

  const afterBeforeSummary = completeTokens(compressed.messages, opts);
  const changed = afterBeforeSummary < before || droppedMessages.length > 0;
  const withSummary = changed
    ? opts.policy.kind === 'proactive'
      ? injectSummaryAtBoundary({ ...compressed, boundaryIndex: splitBy24h(compressed.messages, opts.recentWindowMs, opts.now).olderIndices.length }, opts.now)
      : injectSummaryAtEnd(compressed, opts.now)
    : compressed.messages;
  const after = completeTokens(withSummary, opts);
  const reached = after <= targetTokens;
  if (!changed) {
    if (before <= targetTokens) {
      result = {
        outcome: {
          status: 'no_progress',
          before,
          after,
          reason: 'already_within_target',
          newMessages: compressed.messages,
        },
        droppedMessages: [],
        metrics: {
          droppedSystemMessages: compressed.collapsedSystemMessages,
          collapsedToolResults: compressed.collapsedToolResults,
          collapsedToolUseFields: compressed.collapsedToolUseFields,
          supersededRedundantResults: compressed.supersededRedundantResults,
          summaryMessageInjected: false,
        },
      };
    } else {
      result = makePolicyConflict(
        compressed,
        before,
        after,
        targetTokens,
        opts.fixedTokens > targetTokens ? 'fixed_context_exceeds_ceiling' : 'atomic_turn_boundary',
      );
    }
  } else {
    result = {
      outcome: { status: reached ? 'target_reached' : 'progress', before, after, newMessages: withSummary },
      droppedMessages,
      metrics: {
        droppedSystemMessages: compressed.collapsedSystemMessages,
        collapsedToolResults: compressed.collapsedToolResults,
        collapsedToolUseFields: compressed.collapsedToolUseFields,
        supersededRedundantResults: compressed.supersededRedundantResults,
        summaryMessageInjected: changed,
      },
    };
  }

  // Emit COMPLETED audit
  if (result.outcome.status === 'target_reached' || result.outcome.status === 'progress') {
    opts.audit.write(
      CONTEXT_TRIM_COMPLETED,
      `before=${before}`,
      `after=${result.outcome.after}`,
      `status=${result.outcome.status}`,
      `system_msgs_collapsed=${result.metrics.droppedSystemMessages}`,
      `tool_results_collapsed=${result.metrics.collapsedToolResults}`,
      `tool_use_fields_collapsed=${result.metrics.collapsedToolUseFields}`,
      `redundant_results_superseded=${result.metrics.supersededRedundantResults}`,
      `summary_message_injected=${result.metrics.summaryMessageInjected ? 1 : 0}`,
    );
  }

  return result;
}

/** 在 24h 边界处注入摘要消息（顺手裁用：摘要放在 Tier 3 和 Tier 2 之间） */
function injectSummaryAtBoundary(result: CompressResult, nowMs: number): Message[] {
  const insertAt = findToolPairSafeInsertionIndex(result.messages, result.boundaryIndex);
  const processedCount = Math.max(0, insertAt);
  const summary = buildContextTrimSummaryMessage({
    processedCount,
    subtypeStat: result.subtypeStat,
    toolStat: result.toolStat,
    nowMs,
  });

  const newMessages = [...result.messages];
  newMessages.splice(insertAt, 0, summary);
  return newMessages;
}

/** 在消息列表末尾注入摘要消息（触底裁用：全部消息都参与了压缩） */
function injectSummaryAtEnd(result: CompressResult, nowMs: number): Message[] {
  const insertAt = findToolPairSafeInsertionIndex(result.messages, result.messages.length);
  const processedCount = Math.max(0, insertAt);
  const summary = buildContextTrimSummaryMessage({
    processedCount,
    subtypeStat: result.subtypeStat,
    toolStat: result.toolStat,
    nowMs,
  });

  const newMessages = [...result.messages];
  newMessages.splice(insertAt, 0, summary);
  return newMessages;
}

function emptyCompressResult(messages: readonly Message[], boundaryIndex: number): CompressResult {
  return {
    messages: [...messages],
    subtypeStat: { preserved: {} },
    toolStat: { total: 0, byTool: {} },
    collapsedSystemMessages: 0,
    collapsedToolResults: 0,
    collapsedToolUseFields: 0,
    collapsedTextBlocks: 0,
    collapsedThinkingBlocks: 0,
    supersededRedundantResults: 0,
    boundaryIndex,
  };
}

function mergeCompressResult(
  accumulated: CompressResult,
  next: CompressResult,
  boundaryIndex: number,
): CompressResult {
  const preserved = { ...accumulated.subtypeStat.preserved };
  for (const [key, value] of Object.entries(next.subtypeStat.preserved)) {
    preserved[key] = (preserved[key] ?? 0) + value;
  }
  const byTool = { ...accumulated.toolStat.byTool };
  for (const [key, value] of Object.entries(next.toolStat.byTool)) {
    byTool[key] = (byTool[key] ?? 0) + value;
  }
  return {
    messages: next.messages,
    subtypeStat: { preserved },
    toolStat: { total: accumulated.toolStat.total + next.toolStat.total, byTool },
    collapsedSystemMessages: accumulated.collapsedSystemMessages + next.collapsedSystemMessages,
    collapsedToolResults: accumulated.collapsedToolResults + next.collapsedToolResults,
    collapsedToolUseFields: accumulated.collapsedToolUseFields + next.collapsedToolUseFields,
    collapsedTextBlocks: accumulated.collapsedTextBlocks + next.collapsedTextBlocks,
    collapsedThinkingBlocks: accumulated.collapsedThinkingBlocks + next.collapsedThinkingBlocks,
    supersededRedundantResults: 0,
    boundaryIndex,
  };
}

function compressSequential(
  messages: readonly Message[],
  opts: TrimV2Options,
  targetIndices: readonly number[],
  targetTokens: number,
  boundaryIndex: number,
): CompressResult {
  let result = emptyCompressResult(messages, boundaryIndex);
  let currentTokens = completeTokens(result.messages, opts);
  for (const index of [...targetIndices].sort((a, b) => a - b)) {
    if (currentTokens <= targetTokens) break;
    const candidate = compressMessages(result.messages, opts, new Set([index]));
    const candidateTokens = completeTokens(candidate.messages, opts);
    if (candidateTokens >= currentTokens) continue;
    result = mergeCompressResult(result, candidate, boundaryIndex);
    currentTokens = candidateTokens;
  }
  return result;
}

function makePolicyConflict(
  p14: CompressResult,
  before: number,
  after: number,
  targetTokens: number,
  reason: 'empty_legal_interval' | 'atomic_turn_boundary' | 'fixed_context_exceeds_ceiling',
): TrimV2Result {
  return {
    outcome: {
      status: 'policy_conflict',
      before,
      after,
      floor: targetTokens,
      ceiling: targetTokens,
      reason,
      newMessages: p14.messages,
    },
    droppedMessages: [],
    metrics: {
      droppedSystemMessages: p14.collapsedSystemMessages,
      collapsedToolResults: p14.collapsedToolResults,
      collapsedToolUseFields: p14.collapsedToolUseFields,
      supersededRedundantResults: p14.supersededRedundantResults,
      summaryMessageInjected: false,
    },
  };
}

interface MessageSegment {
  start: number;
  endExclusive: number;
}

function completeTurnSegments(messages: readonly Message[]): MessageSegment[] {
  const starts: number[] = [0];
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    const { origin } = classifyMessage(m);
    if (m.role === 'user' && origin === 'user') {
      starts.push(i);
    }
  }
  return starts.map((start, i) => ({
    start,
    endExclusive: starts[i + 1] ?? messages.length,
  }));
}

/**
 * 对单个 turn 内的消息做选择性丢弃：
 * - 保留：用户消息（origin='user'）、send tool_use 块
 * - 丢弃：text/thinking 块、非 send 的 tool_use（连带 tool_result）、系统消息
 * - 若 turn 既无用户消息也无 send → 整 turn 丢弃
 * - 若保留后只剩一条孤立的 user 消息（无 assistant 跟随）→ 也丢弃（防 API 交替约束违规）
 */
function selectiveDropTurn(turnMessages: Message[]): { kept: Message[]; dropped: Message[]; modified: boolean } {
  const hasSend = turnMessages.some(m => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return false;
    return m.content.some(b => b.type === 'tool_use' && (b as ToolUseBlock).name === 'send');
  });

  const hasUserMessage = turnMessages.some(m => {
    const { origin } = classifyMessage(m);
    return m.role === 'user' && (origin === 'user' || typeof m.content === 'string');
  });

  // 纯噪音 turn（无用户消息且无 send）→ 整 turn 丢弃
  if (!hasUserMessage && !hasSend) {
    return { kept: [], dropped: [...turnMessages], modified: true };
  }

  // 构建待移除的 tool_use_id 集合（所有非 send 的 tool_use）
  const toolUseIdsToRemove = new Set<string>();
  for (const m of turnMessages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && (b as ToolUseBlock).name !== 'send') {
        toolUseIdsToRemove.add((b as ToolUseBlock).id);
      }
    }
  }

  const kept: Message[] = [];
  const dropped: Message[] = [];

  for (const m of turnMessages) {
    const { origin } = classifyMessage(m);
    // 系统消息 → 丢弃
    if (m.role === 'user' && origin === 'system') {
      dropped.push(m);
      continue;
    }

    // Tier 1：用户消息 → 保留
    if (m.role === 'user' && (origin === 'user' || typeof m.content === 'string')) {
      kept.push(m);
      continue;
    }

    // 含 tool_result 的 user 消息 → 过滤掉对应 tool_use 已被移除的 tool_result
    if (m.role === 'user' && typeof m.content !== 'string') {
      const filteredContent = m.content.filter(b => {
        if (b.type !== 'tool_result') return true;
        return !toolUseIdsToRemove.has((b as ToolResultBlock).tool_use_id);
      });
      if (filteredContent.length === 0) {
        dropped.push(m);
      } else if (filteredContent.length !== m.content.length) {
        // 部分 tool_result 被移除
        dropped.push(m); // 原始消息入 dropped（信息不丢失语义）
        kept.push({ ...m, content: filteredContent });
      } else {
        kept.push(m);
      }
      continue;
    }

    // assistant 消息 → 移除 text/thinking/非 send 的 tool_use
    if (m.role === 'assistant' && typeof m.content !== 'string') {
      const filteredContent = m.content.filter(b => {
        if (b.type === 'text') return false;
        if (b.type === 'thinking') return false;
        if (b.type === 'tool_use' && (b as ToolUseBlock).name !== 'send') return false;
        return true;
      });
      if (filteredContent.length === 0) {
        dropped.push(m);
      } else if (filteredContent.length !== m.content.length) {
        dropped.push(m);
        kept.push({ ...m, content: filteredContent });
      } else {
        kept.push(m);
      }
      continue;
    }

    // 兜底：保留
    kept.push(m);
  }

  const modified = dropped.length > 0 || kept.some((m, i) => m !== turnMessages[i]);
  return { kept, dropped, modified };
}

/**
 * 选择性 turn 丢弃：从最旧的 eligible turn 开始，逐个做 selectiveDropTurn，
 * 每处理一个 turn 就估算一次 tokens，达标即停。
 * 替代旧的 trimRecentCompleteTurns（整段切除）。
 */
function dropTurnsSelective(
  result: CompressResult,
  before: number,
  opts: TrimV2Options,
  options?: { onlyBeforeIndex?: number; onlyAfterIndex?: number },
): TrimV2Result {
  const targetTokens =
    opts.policy.kind === 'proactive'
      ? opts.policy.targetCompleteTokens
      : opts.policy.targetCompleteTokens;

  const segments = completeTurnSegments(result.messages);
  let bestMessages = result.messages;
  let bestAfter = completeTokens(bestMessages, opts);
  const allDropped: Message[] = [];

  // 从最旧 turn 开始逐个处理
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    // 删除会改变消息数组长度；每轮按当前 24h 边界重算，不能继续使用
    // 初始 index，否则旧区删除后可能把新窗口消息误纳入下一轮。
    const currentSplit = splitBy24h(bestMessages, opts.recentWindowMs, opts.now);
    const currentBoundary = currentSplit.olderIndices.length;
    if (options?.onlyBeforeIndex !== undefined && seg.start >= currentBoundary) break;
    if (options?.onlyAfterIndex !== undefined && seg.endExclusive <= currentBoundary) continue;
    // 跨边界 turn 的尾部属于 recent 区；丢弃它会让
    // boundaryIndex - droppedMessages.length 不再等于结构位置。
    if (options?.onlyBeforeIndex !== undefined && seg.endExclusive > currentBoundary) break;
    if (options?.onlyAfterIndex !== undefined && seg.start < currentBoundary) continue;

    const turnMsgs = bestMessages.slice(seg.start, seg.endExclusive);
    const { kept, dropped, modified } = selectiveDropTurn(turnMsgs);

    if (!modified) {
      // 此 turn 没有任何内容被丢弃（Tier 1 全保），跳过
      continue;
    }

    // 增量估算 token：只计算本 turn 丢前/丢后的差值，避免每轮全量重算
    const beforeTurn = estimateMessagesTokens(turnMsgs);
    const afterTurn = estimateMessagesTokens(kept);
    const after = bestAfter - beforeTurn + afterTurn;

    // 目标是上限；低于目标仍然合法，不再因为输出预算制造下限。

    // 重建 messages 数组
    const candidate = [
      ...bestMessages.slice(0, seg.start),
      ...kept,
      ...bestMessages.slice(seg.endExclusive),
    ];

    allDropped.push(...dropped);
    bestMessages = candidate;
    bestAfter = after;

    if (after <= targetTokens) break;

    // 重建 segments（消息数组已变，segment 边界可能偏移）
    const newSegments = completeTurnSegments(bestMessages);
    segments.length = 0;
    segments.push(...newSegments);
  }

  if (bestAfter <= targetTokens) {
    return {
      outcome: {
        status: 'target_reached',
        before,
        after: bestAfter,
        newMessages: bestMessages,
      },
      droppedMessages: allDropped,
      metrics: {
        droppedSystemMessages: result.collapsedSystemMessages,
        collapsedToolResults: result.collapsedToolResults,
        collapsedToolUseFields: result.collapsedToolUseFields,
        supersededRedundantResults: result.supersededRedundantResults,
        summaryMessageInjected: false,
      },
    };
  }

  // 已经完成了合法的消息移除，但受保护消息或 fixed context 仍使目标不可达。
  // 保留这次实际进展并显式报告 progress；不能把已发生的变更伪装成
  // policy_conflict，否则调用方会丢掉可恢复的候选结果和审计事实。
  if (allDropped.length > 0) {
    return {
      outcome: {
        status: 'progress',
        before,
        after: bestAfter,
        newMessages: bestMessages,
      },
      droppedMessages: allDropped,
      metrics: {
        droppedSystemMessages: result.collapsedSystemMessages,
        collapsedToolResults: result.collapsedToolResults,
        collapsedToolUseFields: result.collapsedToolUseFields,
        supersededRedundantResults: result.supersededRedundantResults,
        summaryMessageInjected: false,
      },
    };
  }

  // 所有 eligible turn 都处理后仍超标 → policy_conflict
  const fixedExceeds = opts.fixedTokens > targetTokens;
  return makePolicyConflict(
    { ...result, messages: bestMessages },
    before,
    bestAfter,
    targetTokens,
    fixedExceeds ? 'fixed_context_exceeds_ceiling' : 'atomic_turn_boundary',
  );
}

function splitBy24h(
  messages: readonly Message[],
  recentWindowMs: number,
  now: number,
): { olderIndices: number[]; newerIndices: number[] } {
  let latestAddedAtMs = 0;
  for (const m of messages) {
    if (m.addedAt !== undefined) {
      const ts = new Date(m.addedAt).getTime();
      if (ts > latestAddedAtMs) latestAddedAtMs = ts;
    }
  }
  const anchorMs = latestAddedAtMs > 0 ? latestAddedAtMs : now;
  const thresholdMs = anchorMs - recentWindowMs;

  // 新窗口 = 尾部连续 recent run。mid-array 的 recent summary（历史 trim 注入）
  // 不改变边界；若其后仍有 old 消息，它归入 old（仅压缩预览，原文在 archive）。
  let firstNewer = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const addedAt = messages[i].addedAt;
    if (addedAt === undefined) break;
    const ts = new Date(addedAt).getTime();
    if (Number.isNaN(ts) || ts <= thresholdMs) break;
    firstNewer = i;
  }

  const olderIndices: number[] = [];
  const newerIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    (i < firstNewer ? olderIndices : newerIndices).push(i);
  }

  return { olderIndices, newerIndices };
}

function compressMessages(
  messages: readonly Message[],
  opts: TrimV2Options,
  targetIndices?: Set<number>, // undefined = 全部压缩；顺手裁传 olderIndices
): CompressResult {
  // 1. 逐消息处理。每个 tool_result 都按自身正文裁剪；相同调用参数不构成
  // 结果可替代关系，旧结果必须保留自身内容或自身预览。
  const subtypeStat: SubtypeStat = { preserved: {} };
  const toolStat: ToolStat = { total: 0, byTool: {} };
  let collapsedSystemMessages = 0;
  let collapsedToolResults = 0;
  let collapsedToolUseFields = 0;
  let collapsedTextBlocks = 0;
  let collapsedThinkingBlocks = 0;
  let supersededRedundantResults = 0;

  const newMessages: Message[] = [];
  let boundaryIndex = targetIndices === undefined ? messages.length : -1;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const isTarget = targetIndices === undefined || targetIndices.has(i);

    if (!isTarget) {
      // 不在压缩范围内 → 原样保留
      if (boundaryIndex === -1) {
        boundaryIndex = newMessages.length;
      }
      newMessages.push(m);
      continue;
    }

    // origin='system' → 统一压缩预览（不再按 filterSubtypes 分流删除）
    const { origin, systemSubtype } = classifyMessage(m);
    if (m.role === 'user' && origin === 'system') {
      const subtype = systemSubtype ?? 'unknown';
      const collapsed = collapseSystemMessage(m, opts.previewBytes, opts.now);
      subtypeStat.preserved[subtype] = (subtypeStat.preserved[subtype] ?? 0) + 1;
      if (collapsed !== null) {
        newMessages.push(collapsed);
        collapsedSystemMessages++;
      } else {
        newMessages.push(m); // trivial check：折叠后反而变大，保留原文
      }
      continue;
    }

    // assistant → 压缩 text/thinking + 折叠 tool_use input（send 豁免）
    if (m.role === 'assistant' && typeof m.content !== 'string') {
      const { newMsg, collapsedFields, toolNames, collapsedText, collapsedThinking } =
        collapseAssistantMessage(m, opts.previewBytes, opts.now);
      collapsedToolUseFields += collapsedFields;
      collapsedTextBlocks += collapsedText;
      collapsedThinkingBlocks += collapsedThinking;
      for (const name of toolNames) {
        toolStat.total++;
        toolStat.byTool[name] = (toolStat.byTool[name] ?? 0) + 1;
      }
      newMessages.push(newMsg);
      continue;
    }

    // user role 含 tool_result → 折叠 content（P1a）+ 应用 P2 superseded
    if (m.role === 'user' && typeof m.content !== 'string') {
      const { newMsg, collapsedCount } = collapseToolResults(m, opts.previewBytes, opts.now);
      collapsedToolResults += collapsedCount;
      newMessages.push(newMsg);
      continue;
    }

    // Tier 1：user (origin='user') → 永不裁剪
    newMessages.push(m);
  }

  if (boundaryIndex === -1) {
    boundaryIndex = newMessages.length;
  }

  return {
    messages: newMessages,
    subtypeStat,
    toolStat,
    collapsedSystemMessages,
    collapsedToolResults,
    collapsedToolUseFields,
    collapsedTextBlocks,
    collapsedThinkingBlocks,
    supersededRedundantResults,
    boundaryIndex,
  };
}

// --- 内部 helper 函数 ---

function collapseSystemMessage(msg: Message, previewBytes: number, nowMs: number): Message | null {
  if (typeof msg.content !== 'string') return null;
  const body = msg.content;
  const originalBytes = byteLength(body);

  const closeBracketIdx = body.indexOf(']');
  if (closeBracketIdx === -1) {
    return collapseStringContent(msg, body, previewBytes, originalBytes, nowMs);
  }

  const prefix = body.slice(0, closeBracketIdx + 1);
  const restBody = body.slice(closeBracketIdx + 1);

  const preview = truncateUtf8Prefix(restBody, previewBytes);
  const collapsed = `${prefix}${preview}<...>[context-trim: ${byteLength(restBody)} bytes elided. Inspect dialog archive for original.]`;

  if (byteLength(collapsed) >= originalBytes) return null;

  return {
    ...msg,
    content: collapsed,
    trimmed: incrementTrimmed(msg.trimmed, originalBytes, nowMs),
  };
}

function collapseStringContent(
  msg: Message,
  body: string,
  previewBytes: number,
  originalBytes: number,
  nowMs: number,
): Message | null {
  const preview = truncateUtf8Prefix(body, previewBytes);
  const collapsed = `${preview}<...>[context-trim: ${originalBytes} bytes elided. Inspect dialog archive for original.]`;
  if (byteLength(collapsed) >= originalBytes) return null;
  return {
    ...msg,
    content: collapsed,
    trimmed: incrementTrimmed(msg.trimmed, originalBytes, nowMs),
  };
}

function collapseTextBlock(block: TextBlock, previewBytes: number): TextBlock {
  const originalBytes = byteLength(block.text);
  const preview = truncateUtf8Prefix(block.text, previewBytes);
  const blockIdShort = block.blockId?.slice(0, 8) ?? '?';
  const collapsed = `${preview}<...>[context-trim: ${originalBytes} bytes elided. block-id=${blockIdShort}. 查原文: audit lookup --block-id ${blockIdShort}]`;
  if (byteLength(collapsed) >= originalBytes) return block;
  return { ...block, text: collapsed };
}

function collapseThinkingBlock(block: ThinkingBlock, previewBytes: number): ThinkingBlock {
  const originalBytes = byteLength(block.thinking);
  const preview = truncateUtf8Prefix(block.thinking, previewBytes);
  const blockIdShort = block.blockId?.slice(0, 8) ?? '?';
  const collapsed = `${preview}<...>[context-trim: ${originalBytes} bytes elided. block-id=${blockIdShort}. 查原文: audit lookup --block-id ${blockIdShort}]`;
  if (byteLength(collapsed) >= originalBytes) return block;
  return { ...block, thinking: collapsed };
}

function collapseToolResults(
  msg: Message,
  previewBytes: number,
  nowMs: number,
): { newMsg: Message; collapsedCount: number } {
  if (typeof msg.content === 'string') return { newMsg: msg, collapsedCount: 0 };
  let collapsedCount = 0;
  const newContent: ContentBlock[] = msg.content.map(block => {
    if (block.type !== 'tool_result') return block;
    const tr = block as ToolResultBlock;
    const c = tr.content;
    const originalBytes = byteLength(c);
    const preview = truncateUtf8Prefix(c, previewBytes);
    const shortId = tr.blockId;
    const blockIdShort = typeof shortId === 'string' ? shortId.slice(0, 8) : '?';
    const collapsed = `${preview}<...>[context-trim: ${originalBytes} bytes elided. block-id=${blockIdShort}. 查原文: audit lookup --block-id ${blockIdShort}]`;
    if (byteLength(collapsed) >= originalBytes) return block;
    collapsedCount++;
    return {
      ...tr,
      content: collapsed,
    } as ContentBlock;
  });

  const originalContentBytes = byteLength(JSON.stringify(msg.content));
  return {
    newMsg: {
      ...msg,
      content: newContent,
      trimmed: incrementTrimmed(msg.trimmed, originalContentBytes, nowMs),
    },
    collapsedCount,
  };
}

function collapseAssistantMessage(
  msg: Message,
  previewBytes: number,
  nowMs: number,
): {
  newMsg: Message;
  collapsedFields: number;
  toolNames: string[];
  collapsedText: number;
  collapsedThinking: number;
} {
  if (typeof msg.content === 'string') {
    return { newMsg: msg, collapsedFields: 0, toolNames: [], collapsedText: 0, collapsedThinking: 0 };
  }

  let collapsedFields = 0;
  let collapsedText = 0;
  let collapsedThinking = 0;
  const toolNames: string[] = [];

  const newContent: ContentBlock[] = msg.content.map(block => {
    // text block → 压缩预览
    if (block.type === 'text') {
      const textBlock = block as TextBlock;
      const collapsed = collapseTextBlock(textBlock, previewBytes);
      if (collapsed.text !== textBlock.text) collapsedText++;
      return collapsed;
    }

    // thinking block → 压缩预览
    if (block.type === 'thinking') {
      const thinkingBlock = block as ThinkingBlock;
      const collapsed = collapseThinkingBlock(thinkingBlock, previewBytes);
      if (collapsed.thinking !== thinkingBlock.thinking) collapsedThinking++;
      return collapsed;
    }

    if (block.type !== 'tool_use') return block;

    const tu = block as ToolUseBlock;
    toolNames.push(tu.name);

    // === Tier 1: send.content 永不截断 ===
    if (tu.name === 'send') return block;

    // 其余 tool_use：折叠 input 中长 string 字段
    const blockIdShort = tu.blockId?.slice(0, 8) ?? '?';
    const newInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tu.input)) {
      if (typeof v !== 'string') {
        newInput[k] = v;
        continue;
      }
      const originalBytes = byteLength(v);
      const preview = truncateUtf8Prefix(v, previewBytes);
      const collapsed = `${preview}<...>[context-trim: ${originalBytes} bytes elided. block-id=${blockIdShort}. 查原文: audit lookup --block-id ${blockIdShort}]`;
      if (byteLength(collapsed) >= originalBytes) {
        newInput[k] = v;
        continue;
      }
      newInput[k] = collapsed;
      collapsedFields++;
    }
    return { ...tu, input: newInput } as ContentBlock;
  });

  if (collapsedFields === 0 && collapsedText === 0 && collapsedThinking === 0) {
    return { newMsg: msg, collapsedFields: 0, toolNames, collapsedText: 0, collapsedThinking: 0 };
  }

  const originalContentBytes = byteLength(JSON.stringify(msg.content));
  return {
    newMsg: {
      ...msg,
      content: newContent,
      trimmed: incrementTrimmed(msg.trimmed, originalContentBytes, nowMs),
    },
    collapsedFields,
    toolNames,
    collapsedText,
    collapsedThinking,
  };
}

function incrementTrimmed(
  existing: Message['trimmed'],
  originalContentBytes: number,
  nowMs: number,
): NonNullable<Message['trimmed']> {
  const nowIso = new Date(nowMs).toISOString();
  if (existing) {
    return {
      trimmedAt: existing.trimmedAt,
      originalContentBytes: existing.originalContentBytes + originalContentBytes,
      timesTrimmed: (existing.timesTrimmed ?? 1) + 1,
    };
  }
  return {
    trimmedAt: nowIso,
    originalContentBytes,
    timesTrimmed: 1,
  };
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

