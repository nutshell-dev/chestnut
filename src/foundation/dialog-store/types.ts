/**
 * DialogStore types (L2)
 *
 * Session data structure for current.json persistence.
 */

import type { ToolDefinition } from '../llm-provider/index.js';
import type { Message } from './canonical-message.js';
import type { TraceId } from '../audit/index.js';



export interface SessionData {
  version: number;          // bump to 2 (phase 713)
  clawId?: string;          // phase 450: 可选 / subagent ephemeral 用例 0 clawId
  createdAt: string;
  updatedAt: string;
  systemPrompt: string;     // phase 713: per-turn latest snapshot
  messages: Message[];
  toolsForLLM: ToolDefinition[];  // phase 713 NEW
  /** phase 1343 α-6: turn-level trace id for cross-module audit correlation */
  trace_id?: TraceId;
}

/** Phase 987: discriminated union — io_error carries no session so callers must narrow. */
export type LoadResult =
  | { source: 'current' | 'archive' | 'empty'; session: SessionData }
  | { source: 'io_error'; error: string; session: null };

/**
 * phase 1816 (load-stable-exhaustion-downgrades): 稳定入口（loadStable /
 * loadStableTurnBoundary）结果 = 普通 LoadResult + 显式 unstable 分支。
 * mtime 一致性重试耗尽不得退回普通 load() 把无法确认稳定的状态伪装成成功——
 * unstable 携带 attempts 证据、session 为 null，caller 必须 narrow 处理。
 */
export type StableLoadResult =
  | LoadResult
  | { source: 'unstable'; attempts: number; session: null };

/** Dialog session snapshot accepted by the DialogStore persistence boundary. */
export interface DialogSaveSnapshot {
  systemPrompt: string;
  messages: Message[];
  toolsForLLM: ToolDefinition[];
  trace_id?: TraceId;
}

/**
 * phase 1850 Step B: save 双文件提交协议的结构化交付。
 * 主快照（current.json）失败 = reject（无部分提交）；index 失败 = 主快照已提交的事实不丢，
 * 以 blockIndexPersisted=false 回传（dirty 保持、下次 save 自动重试），不 reject。
 */
export interface DialogSaveResult {
  /** 主快照（current.json）提交后，block-index 是否已同步持久化；false 时 dirty 保持、下次 save 重试 */
  blockIndexPersisted: boolean;
}

/**
 * Minimal lifecycle required by a dialog-session consumer.
 *
 * DialogStore owns the persistence semantics; consumers depend on this protocol
 * instead of the concrete store and its unrelated lookup/restore capabilities.
 */
export interface DialogSessionLifecycle {
  load(): Promise<LoadResult>;
  save(snapshot: DialogSaveSnapshot): Promise<DialogSaveResult>;
  beginTurn(): Promise<void>;
  commitTurn(reason?: string): Promise<void>;
  rollbackTurn(reason?: string): Promise<void>;
  archive(): Promise<void>;
}

