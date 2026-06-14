/**
 * Phase 283 立: typed commit function for turn events.
 * Phase 317 迁 L3 共用 infra flat root (ML#5 strict + M#3): subagent (L3) → runtime (L5)
 *   反向 import 违 M#5、原 module 误归 runtime own 违 M#3。迁 src/core/turn-event-commit.ts
 *   flat root (mirror caller-types.ts + claw-id.ts + signals.ts cross-cutting infra pattern)、
 *   depcruise rule `no-subagent-to-runtime` 立防 future regression。
 *
 * By-construction guarantee: every turn event that affects the dialog
 * also emits a corresponding stream event through a single typed function.
 *
 * Anchor: phase 227 turn-completeness 3 对照消除 → 编译期 enforce（M#9）。
 * Dialog append is owned by the agent-executor internally (by-construction);
 * this function owns the stream-emit side to ensure no event is dropped.
 */

import type { ToolUseId } from '../foundation/tool-protocol/index.js';

export type TurnEvent =
  | { kind: 'text_end' }
  | { kind: 'tool_call'; name: string; toolUseId: ToolUseId }
  | { kind: 'tool_result'; name: string; toolUseId: ToolUseId; result: { success: boolean; content: string }; step: number; maxSteps: number };

export interface TurnEventCommitDeps {
  /** Emit text_end to stream consumers. */
  onTextEnd?: () => void;
  /** Emit tool_call to stream consumers. */
  onToolCall?: (name: string, toolUseId: ToolUseId) => void;
  /** Emit tool_result to stream consumers. */
  onToolResult?: (name: string, toolUseId: ToolUseId, result: { success: boolean; content: string }, step: number, maxSteps: number) => void;
}

export function commitTurnEvent(event: TurnEvent, deps: TurnEventCommitDeps): void {
  switch (event.kind) {
    case 'text_end':
      deps.onTextEnd?.();
      break;
    case 'tool_call':
      deps.onToolCall?.(event.name, event.toolUseId);
      break;
    case 'tool_result':
      deps.onToolResult?.(event.name, event.toolUseId, event.result, event.step, event.maxSteps);
      break;
    default: {
      // phase 364 D1 (review-2026-06-13): exhaustive 守。新增 TurnEvent variant
      // 时编译期立即报错而非 silent fall-through。
      const _exhaustive: never = event;
      throw new Error(`commitTurnEvent: unhandled TurnEvent variant: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
