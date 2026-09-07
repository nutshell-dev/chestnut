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

/** Dialog session snapshot accepted by the DialogStore persistence boundary. */
export interface DialogSaveSnapshot {
  systemPrompt: string;
  messages: Message[];
  toolsForLLM: ToolDefinition[];
  trace_id?: TraceId;
}

/**
 * Minimal lifecycle required by a dialog-session consumer.
 *
 * DialogStore owns the persistence semantics; consumers depend on this protocol
 * instead of the concrete store and its unrelated lookup/restore capabilities.
 */
export interface DialogSessionLifecycle {
  load(): Promise<LoadResult>;
  save(snapshot: DialogSaveSnapshot): Promise<void>;
  beginTurn(): Promise<void>;
  commitTurn(reason?: string): Promise<void>;
  rollbackTurn(reason?: string): Promise<void>;
  archive(): Promise<void>;
}

