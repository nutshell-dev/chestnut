/**
 * @module L3.SubAgent.RecoveryState
 * Phase 1933 Step D：SubAgent 通用安全续跑 —— 恢复 checkpoint 的持久化 store。
 * Phase 1933 Step G：恢复游标安全边界 —— 已 toolStarted 无 toolResultCommitted 的
 * 工具按「副作用不确定」处理（RecoveryUncertainSideEffectError，不自动重执行）；
 * next-llm 仅在完整响应 + 全部工具结果 + 对应对话消息都持久化后由
 * commitConversation() 发布（中间态 awaiting-conversation-commit 可仅凭已提交
 * 事实重建对话，不重复请求 LLM）。
 * Phase 1934 Step B（F-12）：提交屏障 —— llmResponseCommitted 在任何新 response
 * 文件写入前拒绝覆盖未提交游标（仅确定不存在或 next-llm 允许）；损坏/读取未知
 * 经 loadCursorStrict 转 typed throw，不按无记录继续（fallbackReason 不得绕过）。
 * Phase 1958 Step B：恢复入口严格三态 —— loadCursorStrict 公开返回
 * missing / valid / unreadable 判别联合；resume 入口仅 missing 允许 fresh
 * baseline，unreadable（损坏/IO/旧 schema 缺字段）由调用方转 typed
 * recovery-required 阻断（SubAgentRecoveryRequiredError），不猜、不按无游标继续。
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
 * - awaiting-tools：完整 LLM 响应已提交，pendingToolIds 中的工具尚未提交结果。
 *   startedToolIds = 已发起（toolStarted 已提交）的工具 id 证据；**缺席（旧版
 *   cursor 无该字段）= 不可证明未开始**，消费方不得猜测为未开始。
 * - awaiting-conversation-commit（Step G 新增）：响应 + 全部工具结果已提交，
 *   对应对话消息尚未证明持久化——重启可仅凭已提交事实重建，不重复请求 LLM、
 *   不重复执行工具；toolResultIds = 全部已提交结果 id。
 * - next-llm：上一回合全部事实（响应/工具结果/对话消息）已提交，下一步是新
 *   LLM 调用；responseId 保留最近已提交响应的锚点（旧版 next-llm 缺此字段 →
 *   读取时不猜，fallbackReason 交代后按无 cursor 回退）。
 */
export type ResumeCursor =
  | { kind: 'awaiting-tools'; responseId: string; pendingToolIds: string[]; startedToolIds?: string[] }
  | { kind: 'awaiting-conversation-commit'; responseId: string; toolResultIds: string[] }
  | { kind: 'next-llm'; responseId: string; conversationVersion: number };

/** loadCursor 结果：cursor 缺席或损坏都不抛——损坏原因交调用方记录回退。 */
export interface RecoveryCursorLoadResult {
  cursor?: ResumeCursor;
  fallbackReason?: string;
}

/**
 * Phase 1958 Step B：游标读取严格三态（恢复决策唯一入口）。
 * - missing：确定不存在（文件缺席）——唯一允许 fresh baseline 的分支；
 * - valid：schema 校验通过，cursor 可按 kind 分发；
 * - unreadable：损坏 / IO / 旧 schema 缺字段（缺字段一律 unreadable，不猜成
 *   missing）——reason 保留原始失败描述，errorKind 区分 io/corrupt；
 *   调用方必须产生 typed recovery-required 阻断，不得按无 cursor 继续。
 */
export type RecoveryCursorStrictLoad =
  | { kind: 'missing' }
  | { kind: 'valid'; cursor: ResumeCursor }
  | { kind: 'unreadable'; reason: string; errorKind: 'io' | 'corrupt' };

/**
 * Phase 1958 Step B：恢复必需错误 —— 恢复事实不可判定（cursor/dialog/已提交事实
 * 不可读或不自洽）时的 typed 阻断 disposition。携带原始 reason 证据；经 run()
 * 既有 catch 分类/audit 路径交上层处置。不删 recovery 文件绕过、不静默全新重启、
 * 不发起下一 LLM、不重执行工具。
 */
export class SubAgentRecoveryRequiredError extends Error {
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`subagent recovery required: ${reason}`);
    this.name = 'SubAgentRecoveryRequiredError';
    this.reason = reason;
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/**
 * cursor.json 磁盘 schema。Phase 1933 Step G 权衡：**保持 schema_version=1 原地扩展**
 * （不升版）——新增 kind/字段均为增量，旧 awaiting-tools 文件缺 startedToolIds /
 * committedToolIds 仍可严格读取（语义 = 不可证明未开始，而非未开始）；唯一不兼容
 * 是旧 next-llm 缺 responseId → 读取时以明确 reason 回退（不猜），无需版本分支。
 */
interface CursorFileV1 {
  schema_version: 1;
  kind: 'awaiting-tools' | 'awaiting-conversation-commit' | 'next-llm';
  responseId?: string;          // 三种 kind 均必填（旧版 next-llm 缺 → legacy 回退）
  pendingToolIds?: string[];    // awaiting-tools 必填
  conversationVersion?: number; // next-llm 必填；其余 kind 可选（版本连续性证据）
  startedToolIds?: string[];    // awaiting-tools 证据：已发起的工具 id（缺 = 旧版 = 不可证明未开始）
  committedToolIds?: string[];  // awaiting-tools 证据：已提交结果 id（转 awaiting-conversation-commit 时合成 toolResultIds）
  toolResultIds?: string[];     // awaiting-conversation-commit 必填：全部已提交结果 id
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

/**
 * Phase 1933 Step G: 不确定副作用错误 —— cursor 证明工具已 toolStarted 但无
 * toolResultCommitted（或旧版 cursor 缺 startedToolIds 证据、不可证明未开始）：
 * 外部副作用是否发生不可知，自动重执行可能重复副作用 → 停止自动执行，
 * 进入调用方既有 catch 分类/audit 路径交上层处置。
 * 不删 recovery 文件绕过、不静默全新重启、不当成功/失败/未开始。
 */
export class RecoveryUncertainSideEffectError extends Error {
  readonly toolUseId: string;
  constructor(toolUseId: string, detail?: string) {
    super(`uncertain side effect: tool ${toolUseId} started without committed result${detail ? ` (${detail})` : ''}`);
    this.name = 'RecoveryUncertainSideEffectError';
    this.toolUseId = toolUseId;
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
 * schema_version===1、kind 三值枚举；
 * awaiting-tools：responseId 非空 + pendingToolIds string[]；
 * awaiting-conversation-commit：responseId 非空 + toolResultIds string[]；
 * next-llm：conversationVersion 非负整数 + responseId 非空
 *   （旧版 next-llm 缺 responseId → legacy_next_llm_without_responseId，不猜）；
 * startedToolIds / committedToolIds 存在时必须是 string[]；
 * conversationVersion 存在时（非 next-llm）必须是非负整数。
 */
function validateCursorFile(v: unknown): { ok: true; file: CursorFileV1 } | { ok: false; reason: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, reason: 'not_an_object' };
  const o = v as Record<string, unknown>;
  if (o.schema_version !== 1) return { ok: false, reason: 'schema_version_not_1' };
  if (o.kind !== 'awaiting-tools' && o.kind !== 'awaiting-conversation-commit' && o.kind !== 'next-llm') {
    return { ok: false, reason: 'kind_unknown' };
  }
  if (o.startedToolIds !== undefined && !isStringArray(o.startedToolIds)) {
    return { ok: false, reason: 'startedToolIds_not_string_array' };
  }
  if (o.committedToolIds !== undefined && !isStringArray(o.committedToolIds)) {
    return { ok: false, reason: 'committedToolIds_not_string_array' };
  }
  if (o.kind === 'awaiting-tools') {
    if (!isNonEmptyString(o.responseId)) return { ok: false, reason: 'responseId_missing' };
    if (!isStringArray(o.pendingToolIds)) return { ok: false, reason: 'pendingToolIds_not_string_array' };
    if (o.conversationVersion !== undefined && !isNonNegativeInteger(o.conversationVersion)) {
      return { ok: false, reason: 'conversationVersion_invalid' };
    }
  } else if (o.kind === 'awaiting-conversation-commit') {
    if (!isNonEmptyString(o.responseId)) return { ok: false, reason: 'responseId_missing' };
    if (!isStringArray(o.toolResultIds)) return { ok: false, reason: 'toolResultIds_not_string_array' };
    if (o.conversationVersion !== undefined && !isNonNegativeInteger(o.conversationVersion)) {
      return { ok: false, reason: 'conversationVersion_invalid' };
    }
  } else {
    if (!isNonNegativeInteger(o.conversationVersion)) return { ok: false, reason: 'conversationVersion_invalid' };
    if (!isNonEmptyString(o.responseId)) return { ok: false, reason: 'legacy_next_llm_without_responseId' };
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
    // Phase 1934 Step B (F-12): 提交屏障 —— 任何新 response 文件写入之前拒绝覆盖
    // 未提交游标（awaiting-tools / awaiting-conversation-commit 的上一响应尚未走完
    // 工具结果 + 对话提交）；损坏/读取未知由 loadCursorStrict 转 typed throw，
    // 不按无记录继续。仅确定不存在或 next-llm（上一回合全部事实已提交）允许写入。
    if (!this.current) await this.assertCursorReadableForWrite('llmResponseCommitted');
    if (this.current && this.current.kind !== 'next-llm') {
      throw new SubAgentRecoveryStoreError(
        'invalid_state',
        `previous response not committed (cursor=${this.current.kind} response=${this.current.responseId})`,
        this.cursorPath,
      );
    }
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
          committedToolIds: [],
        }
      : {
          // Phase 1933 Step G: 无可执行工具（end_turn / prebuilt 全覆盖）→ 无工具结果
          // 等待项，但对话消息尚未持久化 → 不允许直接 next-llm。
          schema_version: 1,
          kind: 'awaiting-conversation-commit',
          responseId,
          toolResultIds: [],
          conversationVersion: baseVersion,
        };
    await this.writeCursor(next);
  }

  async toolStarted(fact: ToolStartedFact): Promise<void> {
    const current = await this.requireCurrentState('toolStarted');
    if (current.kind !== 'awaiting-tools') {
      throw new SubAgentRecoveryStoreError(
        'invalid_state',
        `toolStarted without awaiting-tools cursor (tool=${fact.toolName} id=${fact.toolUseId})`,
        this.cursorPath,
      );
    }
    // 幂等去重：同一 id 重复 started 提交不产生重复证据项
    const started = current.startedToolIds ?? [];
    await this.writeCursor({
      ...current,
      startedToolIds: started.includes(fact.toolUseId) ? started : [...started, fact.toolUseId],
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
    // 幂等去重（对齐 toolStarted）：崩溃窗口后的 resume 重提交不产生重复证据项
    const committedToolIds = (current.committedToolIds ?? []).includes(fact.toolUseId)
      ? current.committedToolIds!
      : [...(current.committedToolIds ?? []), fact.toolUseId];
    const next: CursorFileV1 = remaining.length > 0
      ? { ...current, pendingToolIds: remaining, committedToolIds }
      : {
          // Phase 1933 Step G: 最后结果已提交 ≠ 对话已持久化 —— 转
          // awaiting-conversation-commit 并保留 responseId 锚点；next-llm 仅由
          // commitConversation() 在对话落盘成功后发布。
          schema_version: 1,
          kind: 'awaiting-conversation-commit',
          responseId: current.responseId!,
          toolResultIds: committedToolIds,
          conversationVersion: current.conversationVersion ?? 0,
        };
    await this.writeCursor(next);
  }

  /**
   * Phase 1933 Step G: 对话消息已持久化后推进游标 —— 仅当 cursor 为
   * awaiting-conversation-commit 时原子写 next-llm { responseId, conversationVersion+1 }；
   * 其余状态（无 cursor / awaiting-tools / next-llm）一律 no-op（幂等：onStepComplete
   * 与 finally 的 save 成功路径都会调用，重复/超前调用无害、不产错）。
   * 原子写失败 throw（写路径纪律：失败事实不得静默）。
   * Phase 1934 Z-B1：播种同样走严格加载——损坏/IO 由 loadCursorStrict 转 typed
   * throw，不被 fallbackReason 吞成静默 no-op（否则严格屏障假报成功、cursor 滞留
   * awaiting-conversation-commit）。仅确定不存在（文件缺席）允许无 cursor no-op。
   */
  async commitConversation(): Promise<void> {
    if (!this.current) await this.assertCursorReadableForWrite('commitConversation');
    const current = this.current;
    if (!current || current.kind !== 'awaiting-conversation-commit') return;
    await this.writeCursor({
      schema_version: 1,
      kind: 'next-llm',
      responseId: current.responseId!,
      conversationVersion: (current.conversationVersion ?? 0) + 1,
    });
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
          // Phase 1933 Step G: 保留并校验 started 证据（不再丢弃）；
          // 旧文件缺字段 → undefined = 不可证明未开始（不猜为未开始）
          ...(file.startedToolIds ? { startedToolIds: [...file.startedToolIds] } : {}),
        },
      };
    }
    if (file.kind === 'awaiting-conversation-commit') {
      return {
        cursor: {
          kind: 'awaiting-conversation-commit',
          responseId: file.responseId!,
          toolResultIds: [...file.toolResultIds!],
        },
      };
    }
    return {
      cursor: {
        kind: 'next-llm',
        responseId: file.responseId!,
        conversationVersion: file.conversationVersion!,
      },
    };
  }

  /**
   * Phase 1958 Step B：公开严格三态加载 —— 恢复入口（agent resume）与写路径提交
   * 屏障共用同一判断点。确定不存在 → missing；校验通过 → valid；损坏/IO/旧 schema
   * 缺字段 → unreadable（保留原始 reason，绝不猜成 missing）。
   */
  async loadCursorStrict(): Promise<RecoveryCursorStrictLoad> {
    const loaded = await this.loadCursor();
    if (loaded.cursor) return { kind: 'valid', cursor: loaded.cursor };
    if (loaded.fallbackReason) {
      return {
        kind: 'unreadable',
        reason: loaded.fallbackReason,
        errorKind: loaded.fallbackReason.startsWith('cursor_read_failed') ? 'io' : 'corrupt',
      };
    }
    return { kind: 'missing' };
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
   * Phase 1934 Step B: 严格加载 —— 供写路径提交屏障使用。损坏/IO 不按无记录继续
   * （fallbackReason 不得绕过屏障）：read 失败 → kind 'io'，parse/schema 失败 →
   * kind 'corrupt'，均 typed throw；仅确定不存在（文件缺席）允许无 cursor。
   * Phase 1958 Step B: 与恢复入口共用 loadCursorStrict 单一判断点。
   */
  private async assertCursorReadableForWrite(site: string): Promise<void> {
    const loaded = await this.loadCursorStrict();
    if (loaded.kind !== 'unreadable') return;
    throw new SubAgentRecoveryStoreError(
      loaded.errorKind,
      `${site} blocked: existing cursor unreadable (${loaded.reason})`,
      this.cursorPath,
    );
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
