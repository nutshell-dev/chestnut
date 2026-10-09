/**
 * @module L3.SubAgent.RecoveryState
 * Phase 1933 Step D：SubAgent 通用安全续跑 —— 恢复 checkpoint 的持久化 store。
 *
 * 实现 step-executor 的 RecoveryDelivery 严格交付契约，把「完整 LLM 响应 /
 * 工具意图 / 工具结果」三类事实落盘在 `${resultDir}/recovery/` 下：
 *   - cursor.json                  原子写；schema_version=1 + ResumeCursor 字段
 *   - responses/<responseId>.json  完整 LLM 响应事实（CompleteLLMResponse 序列化）
 *   - tool-results/<toolUseId>.json 已提交工具结果事实（ToolResultFact 序列化）
 *
 * 纪律：
 * - 所有写失败 throw（RecoveryDelivery 契约：阻断副作用、中止 step）。
 * - 读路径严格校验、不猜默认值：cursor 缺字段/坏 JSON → 按无 cursor 处理并把原因
 *   以 typed 结果（fallbackReason）交调用方记录；已提交事实文件损坏 → throw
 *   typed error（SubAgentRecoveryStoreError），由调用方决定回退。
 * - pendingToolIds 语义 = 「需要执行的 tool_use id」：响应内 prebuilt tool_result
 *   已覆盖的 id（phase 1282 stream 侧 parse-error 占位）不执行、不入 pending
 *   （对齐 handleToolUseStop 的 toolCallsToExecute 过滤语义）。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/index.js';
import { formatErr, newUuid } from '../../foundation/node-utils/index.js';
import type {
  RecoveryDelivery,
  CompleteLLMResponse,
  ToolStartedFact,
  ToolResultFact,
} from '../step-executor/index.js';

/**
 * 续跑游标（恢复决策的唯一权威）：
 * - awaiting-tools：完整 LLM 响应已提交，pendingToolIds 中的工具尚未提交结果；
 * - next-llm：上一回合全部事实已提交，下一步是新 LLM 调用。
 */
export type ResumeCursor =
  | { kind: 'awaiting-tools'; responseId: string; pendingToolIds: string[] }
  | { kind: 'next-llm'; conversationVersion: number };

/** loadCursor 结果：cursor 缺席或损坏都不抛——损坏原因交调用方记录回退。 */
export interface RecoveryCursorLoadResult {
  cursor?: ResumeCursor;
  fallbackReason?: string;
}

/** cursor.json 磁盘 schema（v1）。startedToolIds 仅作证据、不影响 pending 判定。 */
interface CursorFileV1 {
  schema_version: 1;
  kind: 'awaiting-tools' | 'next-llm';
  responseId?: string;          // awaiting-tools 必填
  pendingToolIds?: string[];    // awaiting-tools 必填
  conversationVersion?: number; // next-llm 必填；awaiting-tools 可选（版本连续性证据）
  startedToolIds?: string[];    // 可选证据字段
}

export type SubAgentRecoveryErrorKind = 'io' | 'corrupt' | 'missing_response' | 'invalid_state';

/** 恢复存储 typed 错误：读已提交事实失败 / 写路径状态不自洽。 */
export class SubAgentRecoveryStoreError extends Error {
  readonly kind: SubAgentRecoveryErrorKind;
  readonly path?: string;
  constructor(kind: SubAgentRecoveryErrorKind, message: string, path?: string) {
    super(message);
    this.name = 'SubAgentRecoveryStoreError';
    this.kind = kind;
    this.path = path;
  }
}

export interface SubAgentRecoveryStoreOptions {
  fs: FileSystem;
  resultDir: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * cursor.json 严格校验清单（缺一即损坏、不猜）：
 * schema_version===1、kind 枚举、awaiting-tools 时 responseId 非空 string +
 * pendingToolIds string[]、next-llm 时 conversationVersion 非负整数；
 * startedToolIds 存在时必须是 string[]。
 */
function validateCursorFile(v: unknown): { ok: true; file: CursorFileV1 } | { ok: false; reason: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, reason: 'not_an_object' };
  const o = v as Record<string, unknown>;
  if (o.schema_version !== 1) return { ok: false, reason: 'schema_version_not_1' };
  if (o.kind !== 'awaiting-tools' && o.kind !== 'next-llm') return { ok: false, reason: 'kind_unknown' };
  if (o.startedToolIds !== undefined && !isStringArray(o.startedToolIds)) {
    return { ok: false, reason: 'startedToolIds_not_string_array' };
  }
  if (o.kind === 'awaiting-tools') {
    if (!isNonEmptyString(o.responseId)) return { ok: false, reason: 'responseId_missing' };
    if (!isStringArray(o.pendingToolIds)) return { ok: false, reason: 'pendingToolIds_not_string_array' };
    if (o.conversationVersion !== undefined && !isNonNegativeInteger(o.conversationVersion)) {
      return { ok: false, reason: 'conversationVersion_invalid' };
    }
  } else {
    if (!isNonNegativeInteger(o.conversationVersion)) return { ok: false, reason: 'conversationVersion_invalid' };
  }
  return { ok: true, file: o as unknown as CursorFileV1 };
}

function validateCompleteLLMResponse(v: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof v !== 'object' || v === null) return { ok: false, reason: 'not_an_object' };
  const o = v as Record<string, unknown>;
  const response = o.response as Record<string, unknown> | undefined;
  if (typeof response !== 'object' || response === null) return { ok: false, reason: 'response_missing' };
  if (!Array.isArray(response.content)) return { ok: false, reason: 'response.content_not_array' };
  if (typeof response.stop_reason !== 'string') return { ok: false, reason: 'response.stop_reason_not_string' };
  for (const block of response.content) {
    if (typeof block !== 'object' || block === null || typeof (block as { type?: unknown }).type !== 'string') {
      return { ok: false, reason: 'response.content_block_invalid' };
    }
  }
  const llmInfo = o.llmInfo as Record<string, unknown> | undefined;
  if (typeof llmInfo !== 'object' || llmInfo === null) return { ok: false, reason: 'llmInfo_missing' };
  if (typeof llmInfo.model !== 'string') return { ok: false, reason: 'llmInfo.model_not_string' };
  if (typeof o.committedAtMs !== 'number') return { ok: false, reason: 'committedAtMs_not_number' };
  return { ok: true };
}

function validateToolResultFact(v: unknown): { ok: true } | { ok: false; reason: string } {
  if (typeof v !== 'object' || v === null) return { ok: false, reason: 'not_an_object' };
  const o = v as Record<string, unknown>;
  if (!isNonEmptyString(o.toolUseId)) return { ok: false, reason: 'toolUseId_missing' };
  if (typeof o.toolName !== 'string') return { ok: false, reason: 'toolName_not_string' };
  const result = o.result as Record<string, unknown> | undefined;
  if (typeof result !== 'object' || result === null) return { ok: false, reason: 'result_missing' };
  if (typeof result.success !== 'boolean') return { ok: false, reason: 'result.success_not_boolean' };
  if (typeof result.content !== 'string') return { ok: false, reason: 'result.content_not_string' };
  if (typeof o.resultAtMs !== 'number') return { ok: false, reason: 'resultAtMs_not_number' };
  return { ok: true };
}

/** toolUseId 文件名安全化（hex 等价可读性优先：encodeURIComponent 对 ASCII id 零转换）。 */
function encodeFileKey(id: string): string {
  return encodeURIComponent(id);
}

export class SubAgentRecoveryStore implements RecoveryDelivery {
  private readonly fs: FileSystem;
  private readonly resultDir: string;
  /** 本进程最近一次已知 cursor 状态（loadCursor/写路径共同维护；重启后由 loadCursor 重新播种）。 */
  private current: CursorFileV1 | null = null;

  constructor(options: SubAgentRecoveryStoreOptions) {
    this.fs = options.fs;
    this.resultDir = options.resultDir;
  }

  private get recoveryDir(): string {
    return path.join(this.resultDir, 'recovery');
  }
  private get cursorPath(): string {
    return path.join(this.recoveryDir, 'cursor.json');
  }
  private get toolResultsDir(): string {
    return path.join(this.recoveryDir, 'tool-results');
  }
  private responsePath(responseId: string): string {
    return path.join(this.recoveryDir, 'responses', `${encodeFileKey(responseId)}.json`);
  }
  private toolResultPath(toolUseId: string): string {
    return path.join(this.toolResultsDir, `${encodeFileKey(toolUseId)}.json`);
  }

  // ── RecoveryDelivery 写路径（全部原子写；失败 throw 阻断副作用） ──────────

  async llmResponseCommitted(fact: CompleteLLMResponse): Promise<void> {
    const responseId = newUuid();
    await this.fs.writeAtomic(this.responsePath(responseId), JSON.stringify(fact, null, 2));

    const toolUseIds = fact.response.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => String((b as { id: unknown }).id));
    // prebuilt tool_result 覆盖的 id 不执行（phase 1282 占位语义）→ 不入 pending
    const prebuiltIds = new Set(
      fact.response.content
        .filter((b) => b.type === 'tool_result')
        .map((b) => String((b as { tool_use_id: unknown }).tool_use_id)),
    );
    const pending = toolUseIds.filter((id) => !prebuiltIds.has(id));

    const baseVersion = this.current && isNonNegativeInteger(this.current.conversationVersion)
      ? this.current.conversationVersion
      : 0;
    const next: CursorFileV1 = pending.length > 0
      ? {
          schema_version: 1,
          kind: 'awaiting-tools',
          responseId,
          pendingToolIds: pending,
          conversationVersion: baseVersion, // 版本在转 next-llm 时递增；此处仅作连续性证据
          startedToolIds: [],
        }
      : {
          schema_version: 1,
          kind: 'next-llm',
          conversationVersion: baseVersion + 1,
          startedToolIds: [],
        };
    await this.writeCursor(next);
  }

  async toolStarted(fact: ToolStartedFact): Promise<void> {
    const current = await this.requireCurrentState('toolStarted');
    await this.writeCursor({
      ...current,
      startedToolIds: [...(current.startedToolIds ?? []), fact.toolUseId],
    });
  }

  async toolResultCommitted(fact: ToolResultFact): Promise<void> {
    await this.fs.writeAtomic(this.toolResultPath(fact.toolUseId), JSON.stringify(fact, null, 2));
    const current = await this.requireCurrentState('toolResultCommitted');
    if (current.kind !== 'awaiting-tools' || !isStringArray(current.pendingToolIds)) {
      throw new SubAgentRecoveryStoreError(
        'invalid_state',
        `toolResultCommitted without awaiting-tools cursor (tool=${fact.toolName} id=${fact.toolUseId})`,
        this.cursorPath,
      );
    }
    if (!current.pendingToolIds.includes(fact.toolUseId)) {
      throw new SubAgentRecoveryStoreError(
        'invalid_state',
        `toolResultCommitted for id not in pendingToolIds: ${fact.toolUseId}`,
        this.cursorPath,
      );
    }
    const remaining = current.pendingToolIds.filter((id) => id !== fact.toolUseId);
    const next: CursorFileV1 = remaining.length > 0
      ? { ...current, pendingToolIds: remaining }
      : {
          schema_version: 1,
          kind: 'next-llm',
          conversationVersion: (current.conversationVersion ?? 0) + 1,
          // started 证据随游标保留（重启后可佐证哪些工具已发起过）
          ...(current.startedToolIds ? { startedToolIds: current.startedToolIds } : {}),
        };
    await this.writeCursor(next);
  }

  // ── 加载面（agent resume 消费） ─────────────────────────────────────────

  /**
   * 读取游标。文件缺失 → 无 cursor；JSON/schema 严格校验失败 → 不猜：
   * 按无 cursor 处理并把原因以 fallbackReason 交调用方记录。
   */
  async loadCursor(): Promise<RecoveryCursorLoadResult> {
    let raw: string;
    try {
      if (!(await this.fs.exists(this.cursorPath))) return {};
      raw = await this.fs.read(this.cursorPath);
    } catch (err) {
      return { fallbackReason: `cursor_read_failed: ${formatErr(err)}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { fallbackReason: `cursor_parse_failed: ${formatErr(err)}` };
    }
    const validated = validateCursorFile(parsed);
    if (!validated.ok) {
      return { fallbackReason: `cursor_invalid: ${validated.reason}` };
    }
    this.current = validated.file;
    const file = validated.file;
    if (file.kind === 'awaiting-tools') {
      return {
        cursor: {
          kind: 'awaiting-tools',
          responseId: file.responseId!,
          pendingToolIds: [...file.pendingToolIds!],
        },
      };
    }
    return {
      cursor: { kind: 'next-llm', conversationVersion: file.conversationVersion! },
    };
  }

  /** 加载已提交完整响应；损坏/缺失 → throw typed error（调用方决定回退）。 */
  async loadCommittedResponse(responseId: string): Promise<CompleteLLMResponse> {
    const p = this.responsePath(responseId);
    let raw: string;
    try {
      raw = await this.fs.read(p);
    } catch (err) {
      throw new SubAgentRecoveryStoreError(
        'missing_response',
        `committed response unreadable: ${formatErr(err)}`,
        p,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SubAgentRecoveryStoreError('corrupt', `committed response parse failed: ${formatErr(err)}`, p);
    }
    const validated = validateCompleteLLMResponse(parsed);
    if (!validated.ok) {
      throw new SubAgentRecoveryStoreError('corrupt', `committed response invalid: ${validated.reason}`, p);
    }
    return parsed as CompleteLLMResponse;
  }

  /** 加载全部已提交工具结果（按 toolUseId 索引）；任一文件损坏 → throw typed error。 */
  async loadCommittedToolResults(): Promise<Map<string, ToolResultFact>> {
    const out = new Map<string, ToolResultFact>();
    let entries;
    try {
      if (!(await this.fs.exists(this.toolResultsDir))) return out;
      entries = await this.fs.list(this.toolResultsDir);
    } catch (err) {
      throw new SubAgentRecoveryStoreError(
        'io',
        `tool-results dir unreadable: ${formatErr(err)}`,
        this.toolResultsDir,
      );
    }
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith('.json')) continue;
      const p = path.join(this.toolResultsDir, entry.name);
      let raw: string;
      try {
        raw = await this.fs.read(p);
      } catch (err) {
        throw new SubAgentRecoveryStoreError('io', `tool result unreadable: ${formatErr(err)}`, p);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new SubAgentRecoveryStoreError('corrupt', `tool result parse failed: ${formatErr(err)}`, p);
      }
      const validated = validateToolResultFact(parsed);
      if (!validated.ok) {
        throw new SubAgentRecoveryStoreError('corrupt', `tool result invalid: ${validated.reason}`, p);
      }
      const fact = parsed as ToolResultFact;
      out.set(fact.toolUseId, fact);
    }
    return out;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private async writeCursor(file: CursorFileV1): Promise<void> {
    await this.fs.writeAtomic(this.cursorPath, JSON.stringify(file, null, 2));
    this.current = file;
  }

  /**
   * 写路径要求已有 cursor 状态（llmResponseCommitted 先于 toolStarted/toolResultCommitted，
   * 或本进程 loadCursor 已播种）。缺失时尝试从磁盘播种；磁盘也不可得 → throw typed error。
   */
  private async requireCurrentState(site: string): Promise<CursorFileV1> {
    if (this.current) return this.current;
    const loaded = await this.loadCursor();
    if (!this.current) {
      throw new SubAgentRecoveryStoreError(
        'invalid_state',
        `${site} without committed LLM response cursor${loaded.fallbackReason ? ` (cursor load fallback: ${loaded.fallbackReason})` : ' (no cursor on disk)'}`,
        this.cursorPath,
      );
    }
    return this.current;
  }
}

/** 工厂：每 run 一个 store 实例（状态随进程播种/推进；磁盘是唯一跨进程权威）。 */
export function createSubAgentRecoveryStore(opts: SubAgentRecoveryStoreOptions): SubAgentRecoveryStore {
  return new SubAgentRecoveryStore(opts);
}
