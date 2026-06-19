/**
 * @module L4.ContextManager.TrimV2
 * 新裁剪算法、phase 440 实施 phase 421 ratify 的 P1/P1b/P2/P3/P4 + 不动 8 件硬约束。
 */

import type { Message, ContentBlock } from '../../foundation/llm-provider/types.js';
import { estimateMessagesTokens } from '../../foundation/llm-provider/token-estimator.js';
import { ContextTrimExhaustedError } from './errors.js';
import {
  CONTEXT_TRIM_STARTED,
  CONTEXT_TRIM_COMPLETED,
  CONTEXT_TRIM_EXHAUSTED,
} from './audit-events.js';

export type AuditWriter = { write(event: string, ...details: string[]): void };

export interface TrimV2Options {
  recentWindowMs: number;
  previewBytes: number;
  filterSubtypes: ReadonlySet<string>;
  targetMessagesTokens: number;
  now: number;
  audit?: AuditWriter;
}

export interface TrimV2Result {
  newMessages: Message[];
  droppedSystemMessages: number;
  collapsedToolResults: number;
  collapsedToolUseFields: number;
  supersededRedundantResults: number;
  summaryMessageInjected: boolean;
  estimatedTokensAfter: number;
}

interface SubtypeStat {
  preserved: Record<string, number>;
  filtered: Record<string, number>;
}

interface ToolStat {
  total: number;
  byTool: Record<string, number>;
}

/**
 * 新裁剪算法、phase 440 实施 phase 421 ratify 的 P1/P1b/P2/P3/P4 + 不动 8 件硬约束。
 *
 * pure function、不涉持久化（archive + save 由 trimAndPersist orchestration 承担）。
 *
 * 输入：messages（含 metadata）+ options。
 * 输出：newMessages 内存引用、可被 caller 替换自身 messages 引用。
 *
 * 失败：裁后仍超 targetMessagesTokens → throw ContextTrimExhaustedError。
 */
export function trimV2(messages: readonly Message[], opts: TrimV2Options): TrimV2Result {
  const beforeTokens = estimateMessagesTokens(messages);

  opts.audit?.write(CONTEXT_TRIM_STARTED, `before=${beforeTokens}`, `target=${opts.targetMessagesTokens}`);

  if (beforeTokens <= opts.targetMessagesTokens) {
    return {
      newMessages: [...messages],
      droppedSystemMessages: 0,
      collapsedToolResults: 0,
      collapsedToolUseFields: 0,
      supersededRedundantResults: 0,
      summaryMessageInjected: false,
      estimatedTokensAfter: beforeTokens,
    };
  }

  // 1. 算 24h 边界
  const thresholdMs = opts.now - opts.recentWindowMs;
  const olderIdx: number[] = [];
  const newerIdx: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    const addedAt = messages[i].addedAt;
    if (addedAt === undefined) {
      newerIdx.push(i);
    } else {
      const ts = new Date(addedAt).getTime();
      if (ts > thresholdMs) newerIdx.push(i);
      else olderIdx.push(i);
    }
  }

  // 2. 构建 tool_use_id → assistant message idx 映射
  const toolUseIdToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        toolUseIdToAssistantIdx.set(block.id as string, i);
      }
    }
  }

  // 3. 24h 外消息处理
  const newOlder: Array<Message | null> = [];
  const subtypeStat: SubtypeStat = { preserved: {}, filtered: {} };
  const toolStat: ToolStat = { total: 0, byTool: {} };
  let droppedSystemMessages = 0;
  let collapsedToolResults = 0;
  let collapsedToolUseFields = 0;
  let supersededRedundantResults = 0;

  // P2 重复检测：scan 所有 tool_result、按 (tool_name + input hash) 分组、保最新、其余标 superseded
  const supersededIds = new Set<string>();
  {
    const groups = new Map<string, string[]>();
    for (const idx of olderIdx) {
      const m = messages[idx];
      if (m.role !== 'user' || typeof m.content === 'string') continue;
      for (const block of m.content) {
        if (block.type !== 'tool_result') continue;
        const tr = block as { tool_use_id: string; content: string };
        const assistantIdx = toolUseIdToAssistantIdx.get(tr.tool_use_id);
        if (assistantIdx === undefined) continue;
        const assistantMsg = messages[assistantIdx];
        if (typeof assistantMsg.content === 'string') continue;
        const tuBlock = assistantMsg.content.find(
          b => b.type === 'tool_use' && (b as { id: string }).id === tr.tool_use_id,
        ) as { name: string; input: Record<string, unknown> } | undefined;
        if (!tuBlock) continue;
        const key = `${tuBlock.name}::${stableHash(tuBlock.input)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(tr.tool_use_id);
      }
    }
    for (const [, tuIds] of groups) {
      if (tuIds.length > 1) {
        for (let i = 0; i < tuIds.length - 1; i++) {
          supersededIds.add(tuIds[i]);
          supersededRedundantResults++;
        }
      }
    }
  }

  for (const idx of olderIdx) {
    const m = messages[idx];

    // P3 origin='system'
    if (m.role === 'user' && m.origin === 'system') {
      const subtype = m.systemSubtype ?? 'unknown';
      if (opts.filterSubtypes.has(subtype)) {
        subtypeStat.filtered[subtype] = (subtypeStat.filtered[subtype] ?? 0) + 1;
        newOlder.push(null);
        droppedSystemMessages++;
      } else {
        const collapsed = collapseSystemMessage(m, opts.previewBytes, opts.now);
        subtypeStat.preserved[subtype] = (subtypeStat.preserved[subtype] ?? 0) + 1;
        newOlder.push(collapsed ?? m);
      }
      continue;
    }

    // assistant role：折叠 tool_use 入参长 string 字段（P1b）
    if (m.role === 'assistant' && typeof m.content !== 'string') {
      const { newMsg, collapsedFields, toolNames } = collapseAssistantToolUseInputs(m, opts.previewBytes, opts.now);
      collapsedToolUseFields += collapsedFields;
      for (const name of toolNames) {
        toolStat.total++;
        toolStat.byTool[name] = (toolStat.byTool[name] ?? 0) + 1;
      }
      newOlder.push(newMsg);
      continue;
    }

    // user role 含 tool_result：折叠 content（P1a）+ 应用 P2 superseded
    if (m.role === 'user' && typeof m.content !== 'string') {
      const { newMsg, collapsedCount } = collapseToolResults(m, opts.previewBytes, supersededIds, opts.now);
      collapsedToolResults += collapsedCount;
      newOlder.push(newMsg);
      continue;
    }

    // 其他（origin='user' 真消息 — 按 unchanged 保）
    newOlder.push(m);
  }

  // 4. P4 聚合摘要消息构建
  const summaryMessage = buildSummaryMessage(olderIdx.length, subtypeStat, toolStat, opts.now);

  // 5. 组装 newMessages：[新 24h 外 (含 null 去除) + 聚合摘要 + 24h 内]
  const newMessages: Message[] = [];
  for (const m of newOlder) {
    if (m !== null) newMessages.push(m);
  }
  let summaryInjected = false;
  if (olderIdx.length > 0) {
    newMessages.push(summaryMessage);
    summaryInjected = true;
  }
  for (const idx of newerIdx) {
    newMessages.push(messages[idx]);
  }

  // 6. 估算裁后 tokens、若仍超 → throw
  const afterTokens = estimateMessagesTokens(newMessages);

  if (afterTokens > opts.targetMessagesTokens) {
    opts.audit?.write(
      CONTEXT_TRIM_EXHAUSTED,
      `before=${beforeTokens}`,
      `after=${afterTokens}`,
      `target=${opts.targetMessagesTokens}`,
    );
    throw new ContextTrimExhaustedError(
      `Trim v2 exhausted: ${afterTokens} > ${opts.targetMessagesTokens}`,
    );
  }

  // 7. emit COMPLETED audit（含 metrics）
  opts.audit?.write(
    CONTEXT_TRIM_COMPLETED,
    `before=${beforeTokens}`,
    `after=${afterTokens}`,
    `system_msgs_dropped=${droppedSystemMessages}`,
    `tool_results_collapsed=${collapsedToolResults}`,
    `tool_use_fields_collapsed=${collapsedToolUseFields}`,
    `redundant_results_superseded=${supersededRedundantResults}`,
    `summary_message_injected=${summaryInjected ? 1 : 0}`,
  );

  return {
    newMessages,
    droppedSystemMessages,
    collapsedToolResults,
    collapsedToolUseFields,
    supersededRedundantResults,
    summaryMessageInjected: summaryInjected,
    estimatedTokensAfter: afterTokens,
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

  const preview = restBody.slice(0, previewBytes);
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
  const preview = body.slice(0, previewBytes);
  const collapsed = `${preview}<...>[context-trim: ${originalBytes} bytes elided. Inspect dialog archive for original.]`;
  if (byteLength(collapsed) >= originalBytes) return null;
  return {
    ...msg,
    content: collapsed,
    trimmed: incrementTrimmed(msg.trimmed, originalBytes, nowMs),
  };
}

function collapseToolResults(
  msg: Message,
  previewBytes: number,
  supersededIds: Set<string>,
  nowMs: number,
): { newMsg: Message; collapsedCount: number } {
  if (typeof msg.content === 'string') return { newMsg: msg, collapsedCount: 0 };
  let collapsedCount = 0;
  const newContent: ContentBlock[] = msg.content.map(block => {
    if (block.type !== 'tool_result') return block;
    const tr = block as { tool_use_id: string; content: string };
    if (supersededIds.has(tr.tool_use_id)) {
      collapsedCount++;
      return {
        ...tr,
        content: `[superseded by tool_use_id=<newer>]`,
      } as unknown as ContentBlock;
    }
    const c = tr.content;
    const originalBytes = byteLength(c);
    const preview = c.slice(0, previewBytes);
    const collapsed = `${preview}<...>[context-trim: ${originalBytes} bytes elided. tool_use_id=${tr.tool_use_id}. Inspect dialog archive for original.]`;
    if (byteLength(collapsed) >= originalBytes) return block;
    collapsedCount++;
    return {
      ...tr,
      content: collapsed,
    } as unknown as ContentBlock;
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

function collapseAssistantToolUseInputs(
  msg: Message,
  previewBytes: number,
  nowMs: number,
): { newMsg: Message; collapsedFields: number; toolNames: string[] } {
  if (typeof msg.content === 'string') return { newMsg: msg, collapsedFields: 0, toolNames: [] };
  let collapsedFields = 0;
  const toolNames: string[] = [];
  const newContent: ContentBlock[] = msg.content.map(block => {
    if (block.type !== 'tool_use') return block;
    const tu = block as { name: string; input: Record<string, unknown> };
    toolNames.push(tu.name);
    const newInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tu.input)) {
      if (typeof v !== 'string') {
        newInput[k] = v;
        continue;
      }
      const originalBytes = byteLength(v);
      const preview = v.slice(0, previewBytes);
      const collapsed = `${preview}<...>[truncated: ${originalBytes} bytes]`;
      if (byteLength(collapsed) >= originalBytes) {
        newInput[k] = v;
        continue;
      }
      newInput[k] = collapsed;
      collapsedFields++;
    }
    return { ...tu, input: newInput } as unknown as ContentBlock;
  });

  if (collapsedFields === 0) return { newMsg: msg, collapsedFields: 0, toolNames };

  const originalContentBytes = byteLength(JSON.stringify(msg.content));
  return {
    newMsg: {
      ...msg,
      content: newContent,
      trimmed: incrementTrimmed(msg.trimmed, originalContentBytes, nowMs),
    },
    collapsedFields,
    toolNames,
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
  const filteredStr = Object.entries(subtypeStat.filtered)
    .map(([k, v]) => `${k} × ${v}`)
    .join('、') || '无';
  const toolStr = Object.entries(toolStat.byTool)
    .map(([k, v]) => `${k} ${v}`)
    .join('、') || '无';
  const content = `[context-trim summary] 以下为裁剪边界（裁剪时间：${nowIso}）。前 ${processedCount} 条 24h 外消息已处理：系统通知（保留预览）：${preservedStr}；系统通知（已过滤）：${filteredStr}；工具调用：${toolStat.total} 次（${toolStr}）。查回原文：dialog 归档 archive/<ts>_<uuid>.json`;
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
