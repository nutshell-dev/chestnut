/**
 * @module L4.ContextManager.TrimV2
 * phase 1190 三层分类裁剪策略：Tier 1 不裁 / Tier 2 尽量不裁 / Tier 3 可裁。
 */

import type {
  Message,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../foundation/llm-provider/index.js';
import { estimateMessagesTokens } from '../../foundation/llm-provider/index.js';
import { truncateUtf8Prefix } from '../../foundation/node-utils/index.js';
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
  | {
      kind: 'reactive';
      completeFloorTokens: number;
      completeCeilingTokens: number;
    };

export interface TrimV2Options {
  recentWindowMs: number;
  previewBytes: number;
  fixedTokens: number;
  policy: TrimPolicy;
  now: number;
  audit?: AuditWriter;
}

export interface TrimV2Result {
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

interface SubtypeStat {
  preserved: Record<string, number>;
}

interface ToolStat {
  total: number;
  byTool: Record<string, number>;
}

/** 构造 reactive 裁剪策略：完整 prompt 必须落在 [floor, ceiling]。 */
export function buildReactiveTrimPolicy(input: {
  contextWindow: number;
  explicitMaxTokens: number | undefined;
}): Extract<TrimPolicy, { kind: 'reactive' }> {
  const reserveOutputTokens = input.explicitMaxTokens ?? 0;
  return {
    kind: 'reactive',
    completeFloorTokens: Math.floor(
      input.contextWindow * REACTIVE_CONTEXT_RETENTION_FLOOR_RATIO,
    ),
    completeCeilingTokens: input.contextWindow - reserveOutputTokens,
  };
}

/** 构造 proactive 顺手裁策略：消息历史目标上限。 */
export function buildProactiveTrimPolicy(contextWindow: number): Extract<TrimPolicy, { kind: 'proactive' }> {
  return {
    kind: 'proactive',
    targetCompleteTokens: Math.floor(contextWindow * CONTEXT_TRIM_TARGET_RATIO),
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
  const before = opts.fixedTokens + estimateMessagesTokens(messages);

  const targetLabel =
    opts.policy.kind === 'proactive'
      ? `target=${opts.policy.targetCompleteTokens}`
      : `floor=${opts.policy.completeFloorTokens},ceiling=${opts.policy.completeCeilingTokens}`;
  opts.audit?.write(CONTEXT_TRIM_STARTED, `before=${before}`, `fixed=${opts.fixedTokens}`, targetLabel);

  let result: TrimV2Result;

  if (opts.policy.kind === 'proactive') {
    // === 顺手裁：仅压缩 Tier 3（24h 外）===
    const { olderIndices } = splitBy24h(messages, opts.recentWindowMs, opts.now);

    if (olderIndices.length === 0) {
      // 无 24h 外消息 → 不裁
      result = makeTrimResult('no_progress', before, before, {
        messages: [...messages],
        subtypeStat: { preserved: {} },
        toolStat: { total: 0, byTool: {} },
        collapsedSystemMessages: 0,
        collapsedToolResults: 0,
        collapsedToolUseFields: 0,
        collapsedTextBlocks: 0,
        collapsedThinkingBlocks: 0,
        supersededRedundantResults: 0,
        boundaryIndex: messages.length,
      }, opts.policy, false);
    } else {
      const compressed = compressMessages(messages, opts, new Set(olderIndices));
      const compressedAfter = opts.fixedTokens + estimateMessagesTokens(compressed.messages);

      if (compressedAfter <= opts.policy.targetCompleteTokens) {
        // 压缩够用 → 注入摘要，完成（仅当确实发生压缩时才注入摘要）
        const didCompress = compressedAfter < before;
        const withSummary = didCompress ? injectSummaryAtBoundary(compressed, opts.now) : compressed.messages;
        const withSummaryAfter = opts.fixedTokens + estimateMessagesTokens(withSummary);
        result = makeTrimResult(
          withSummaryAfter < before ? 'target_reached' : 'no_progress',
          before,
          withSummaryAfter,
          { ...compressed, messages: withSummary, boundaryIndex: didCompress ? compressed.boundaryIndex + 1 : compressed.boundaryIndex },
          opts.policy,
          didCompress,
        );
      } else {
        // 压缩不够 → 先选择性丢弃 Tier 3 最旧 turn，再注入摘要
        const dropped = dropTurnsSelective(compressed, before, opts, {
          onlyBeforeIndex: compressed.boundaryIndex,
        });
        const newBoundaryIndex = Math.max(0, compressed.boundaryIndex - dropped.droppedMessages.length);
        const finalMessages = injectSummaryAtBoundary(
          { ...compressed, messages: dropped.outcome.newMessages, boundaryIndex: newBoundaryIndex },
          opts.now,
        );
        result = {
          outcome: { ...dropped.outcome, newMessages: finalMessages },
          droppedMessages: dropped.droppedMessages,
          metrics: { ...dropped.metrics, summaryMessageInjected: true },
        };
      }
    }
  } else {
    // === 触底裁：压缩全部消息（Tier 3 + Tier 2）===
    const compressed = compressMessages(messages, opts);
    const compressedAfter = opts.fixedTokens + estimateMessagesTokens(compressed.messages);

    if (opts.policy.completeFloorTokens > opts.policy.completeCeilingTokens) {
      result = makePolicyConflict(
        compressed,
        before,
        compressedAfter,
        opts.policy,
        'empty_legal_interval',
      );
    } else if (compressedAfter <= opts.policy.completeCeilingTokens) {
      // 压缩够用 → 注入摘要（在最后一条被压缩消息之后，即消息末尾），仅当确实发生压缩时
      const didCompress = compressedAfter < before;
      const withSummary = didCompress ? injectSummaryAtEnd(compressed, opts.now) : compressed.messages;
      const withSummaryAfter = opts.fixedTokens + estimateMessagesTokens(withSummary);
      result = makeTrimResult(
        withSummaryAfter < before ? 'target_reached' : 'no_progress',
        before,
        withSummaryAfter,
        { ...compressed, messages: withSummary },
        opts.policy,
        didCompress,
      );
    } else {
      // 压缩不够 → 先选择性丢弃最旧 turn，再注入摘要（在末尾）
      const dropped = dropTurnsSelective(compressed, before, opts);
      const finalMessages = injectSummaryAtEnd(
        { ...compressed, messages: dropped.outcome.newMessages },
        opts.now,
      );
      result = {
        outcome: { ...dropped.outcome, newMessages: finalMessages },
        droppedMessages: dropped.droppedMessages,
        metrics: { ...dropped.metrics, summaryMessageInjected: true },
      };
    }
  }

  // Emit COMPLETED audit
  if (result.outcome.status === 'target_reached' || result.outcome.status === 'progress') {
    opts.audit?.write(
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
  const processedCount = Math.max(0, result.boundaryIndex);
  const summary = buildSummaryMessage(processedCount, result.subtypeStat, result.toolStat, nowMs);

  const insertAt = result.boundaryIndex;
  const newMessages = [...result.messages];
  newMessages.splice(insertAt, 0, summary);
  return newMessages;
}

/** 在消息列表末尾注入摘要消息（触底裁用：全部消息都参与了压缩） */
function injectSummaryAtEnd(result: CompressResult, nowMs: number): Message[] {
  const processedCount = result.messages.length;
  const summary = buildSummaryMessage(processedCount, result.subtypeStat, result.toolStat, nowMs);
  return [...result.messages, summary];
}

function makeTrimResult(
  status: 'target_reached' | 'progress' | 'no_progress',
  before: number,
  after: number,
  p14: CompressResult,
  policy: TrimPolicy,
  summaryInjected: boolean,
): TrimV2Result {
  const outcome: TrimCandidateOutcome =
    status === 'no_progress'
      ? {
          status,
          before,
          after,
          reason:
            policy.kind === 'proactive' && after <= policy.targetCompleteTokens
              ? 'already_within_target'
              : 'transform_did_not_reduce',
          newMessages: p14.messages,
        }
      : {
          status,
          before,
          after,
          newMessages: p14.messages,
        };
  return {
    outcome,
    droppedMessages: [],
    metrics: {
      droppedSystemMessages: p14.collapsedSystemMessages,
      collapsedToolResults: p14.collapsedToolResults,
      collapsedToolUseFields: p14.collapsedToolUseFields,
      supersededRedundantResults: p14.supersededRedundantResults,
      summaryMessageInjected: summaryInjected,
    },
  };
}

function makePolicyConflict(
  p14: CompressResult,
  before: number,
  after: number,
  policy: Extract<TrimPolicy, { kind: 'reactive' }>,
  reason: 'empty_legal_interval' | 'atomic_turn_boundary' | 'fixed_context_exceeds_ceiling',
): TrimV2Result {
  return {
    outcome: {
      status: 'policy_conflict',
      before,
      after,
      floor: policy.completeFloorTokens,
      ceiling: policy.completeCeilingTokens,
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
    if (m.role === 'user' && m.origin === 'user') {
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

  const hasUserMessage = turnMessages.some(m => m.role === 'user' && m.origin === 'user');

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
    // 系统消息 → 丢弃
    if (m.role === 'user' && m.origin === 'system') {
      dropped.push(m);
      continue;
    }

    // Tier 1：用户消息 → 保留
    if (m.role === 'user' && m.origin === 'user') {
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

  // API validity：若保留后只剩 1 条孤立的 user 消息（无后续 assistant），
  // 则这条 user 消息也会造成 user→user 或 user→EOF 违规 → 一并丢弃
  if (kept.length === 1 && kept[0].role === 'user' && (kept[0] as Message).origin === 'user') {
    dropped.push(kept[0]);
    return { kept: [], dropped, modified: true };
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
  options?: { onlyBeforeIndex?: number },
): TrimV2Result {
  const targetTokens =
    opts.policy.kind === 'proactive'
      ? opts.policy.targetCompleteTokens
      : opts.policy.completeCeilingTokens;

  const segments = completeTurnSegments(result.messages);
  const eligibleEnd = options?.onlyBeforeIndex ?? result.messages.length;
  const floorTokens =
    opts.policy.kind === 'reactive'
      ? (opts.policy as Extract<TrimPolicy, { kind: 'reactive' }>).completeFloorTokens
      : 0;

  let bestMessages = result.messages;
  let bestAfter = opts.fixedTokens + estimateMessagesTokens(bestMessages);
  const allDropped: Message[] = [];

  // 从最旧 turn 开始逐个处理
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const seg = segments[segIdx];
    if (seg.start >= eligibleEnd) break; // 超过可丢范围，停

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

    // reactive 必须保留 >= floor；若 dropping 后低于 floor，则此 turn 不能丢
    if (opts.policy.kind === 'reactive' && after < floorTokens) {
      break;
    }

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

  if (bestAfter <= targetTokens && bestAfter >= floorTokens) {
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

  // 所有 eligible turn 都处理后仍超标 → policy_conflict
  const fixedExceeds = opts.fixedTokens > targetTokens;
  return makePolicyConflict(
    { ...result, messages: bestMessages },
    before,
    bestAfter,
    opts.policy.kind === 'reactive'
      ? (opts.policy as Extract<TrimPolicy, { kind: 'reactive' }>)
      : { kind: 'reactive', completeFloorTokens: 0, completeCeilingTokens: targetTokens },
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

  const olderIndices: number[] = [];
  const newerIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const addedAt = messages[i].addedAt;
    if (addedAt === undefined) {
      olderIndices.push(i);
    } else {
      const ts = new Date(addedAt).getTime();
      if (ts > thresholdMs) newerIndices.push(i);
      else olderIndices.push(i);
    }
  }

  return { olderIndices, newerIndices };
}

function compressMessages(
  messages: readonly Message[],
  opts: TrimV2Options,
  targetIndices?: Set<number>, // undefined = 全部压缩；顺手裁传 olderIndices
): CompressResult {
  // 1. 构建 tool_use_id → assistant message idx 映射（P2 去重用）
  const toolUseIdToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        toolUseIdToAssistantIdx.set((block as ToolUseBlock).id, i);
      }
    }
  }

  // 2. P2 重复检测（仅在 targetIndices 范围内检测，但需要全量 tool_use_id 映射）
  const supersededById = new Map<string, string>();
  {
    const groups = new Map<string, string[]>();
    for (let i = 0; i < messages.length; i++) {
      if (targetIndices !== undefined && !targetIndices.has(i)) continue;
      const m = messages[i];
      if (m.role !== 'user' || typeof m.content === 'string') continue;
      for (const block of m.content) {
        if (block.type !== 'tool_result') continue;
        const tr = block as ToolResultBlock;
        const assistantIdx = toolUseIdToAssistantIdx.get(tr.tool_use_id);
        if (assistantIdx === undefined) continue;
        const assistantMsg = messages[assistantIdx];
        if (typeof assistantMsg.content === 'string') continue;
        const tuBlock = assistantMsg.content.find(
          b => b.type === 'tool_use' && (b as ToolUseBlock).id === tr.tool_use_id,
        ) as ToolUseBlock | undefined;
        if (!tuBlock) continue;
        const key = `${tuBlock.name}::${stableHash(tuBlock.input)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(tr.tool_use_id);
      }
    }
    for (const [, tuIds] of groups) {
      if (tuIds.length > 1) {
        const newestId = tuIds[tuIds.length - 1];
        for (let i = 0; i < tuIds.length - 1; i++) {
          supersededById.set(tuIds[i], newestId);
        }
      }
    }
  }

  // 3. 逐消息处理
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
    if (m.role === 'user' && m.origin === 'system') {
      const subtype = m.systemSubtype ?? 'unknown';
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
      const { newMsg, collapsedCount } = collapseToolResults(m, opts.previewBytes, supersededById, opts.now);
      collapsedToolResults += collapsedCount;
      // 统计被 superseded 的数量
      for (const block of (m as Message).content as ContentBlock[]) {
        if (block.type === 'tool_result' && supersededById.has((block as ToolResultBlock).tool_use_id)) {
          supersededRedundantResults++;
        }
      }
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
  supersededById: Map<string, string>,
  nowMs: number,
): { newMsg: Message; collapsedCount: number } {
  if (typeof msg.content === 'string') return { newMsg: msg, collapsedCount: 0 };
  let collapsedCount = 0;
  const newContent: ContentBlock[] = msg.content.map(block => {
    if (block.type !== 'tool_result') return block;
    const tr = block as ToolResultBlock;
    const supersededBy = supersededById.get(tr.tool_use_id);
    if (supersededBy !== undefined) {
      collapsedCount++;
      return {
        ...tr,
        content: `[superseded by tool_use_id=${supersededBy}]`,
      } as ContentBlock;
    }
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

function buildSummaryMessage(
  processedCount: number,
  subtypeStat: SubtypeStat,
  toolStat: ToolStat,
  nowMs: number,
): Message {
  const nowIso = new Date(nowMs).toISOString();
  const preservedStr = Object.entries(subtypeStat.preserved)
    .map(([k, v]) => `${k} × ${v}`)
    .join('、') || '无';
  const toolStr = Object.entries(toolStat.byTool)
    .map(([k, v]) => `${k} ${v}`)
    .join('、') || '无';
  const content = `[context-trim summary] 以下为裁剪边界（裁剪时间：${nowIso}）。前 ${processedCount} 条消息已处理：系统通知（保留预览）：${preservedStr}；工具调用：${toolStat.total} 次（${toolStr}）。查回原文：dialog 归档 archive/<ts>_<uuid>.json`;
  return {
    role: 'user',
    content,
    origin: 'system',
    systemSubtype: 'context_trim_summary',
    addedAt: nowIso,
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

function stableHash(obj: unknown): string {
  const sortedKeys = (o: unknown): unknown => {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(sortedKeys);
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o as Record<string, unknown>).sort()) {
      sorted[k] = sortedKeys((o as Record<string, unknown>)[k]);
    }
    return sorted;
  };
  return JSON.stringify(sortedKeys(obj));
}
