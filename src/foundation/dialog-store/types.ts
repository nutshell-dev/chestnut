/**
 * DialogStore types (L2)
 *
 * Session data structure for current.json persistence.
 */

import type { Message, ToolDefinition } from '../llm-provider/types.js';
import type { ToolUseId } from '../tool-protocol/index.js';
import type { TraceId } from '../audit/types.js';



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

/** phase 466: marker 模式 for subagent context restoration */
export interface DialogMarker {
  clawId: string;
  toolUseId: ToolUseId;
}

/** phase 466: restorePrefix 返完整前缀 */
export interface RestoreResult {
  messages: Message[];                              // marker 时刻 messages 切片（含 marker 那条 assistant message）
  systemPrompt: string;                             // 该 SessionData 的 systemPrompt（phase 713: per-turn snapshot）
  toolsForLLM: ToolDefinition[];                    // phase 713 NEW
  meta: {
    foundIn: 'current' | 'archive';
    foundFile?: string;
    /** Phase 997/999: populated when current.json was degraded and archive was used as fallback. */
    degradationNotes?: [string, ...string[]];
  };
}
