/**
 * subagent run 收尾 multi-artifact 完整性 cross-source audit。
 *
 * 应然 anchor（per design/modules/l3_subagent.md §「persist-state observability」、phase 270 Step B + phase 283）：
 * - AC-4 phase 224 同源 bug 子代理检测：textEndCount > 0 但末轮 dialog 非 assistant text
 *
 * 已删（phase 283 by-construction equal via commitTurnEvent in src/core/turn-event-commit.ts、phase 317 迁 L3 共用 infra flat root）：
 * - AC-1/AC-2/AC-3/AC-5/AC-6 counter check
 *
 * 不 throw（DP1 + Path #4 防 break finally）。
 */

import type { AuditLog } from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { SUBAGENT_AUDIT_EVENTS } from './audit-events.js';

export interface ArtifactSnapshot {
  readonly agentId: string;
  readonly resultDir: string;
  readonly textEndCount: number;
}

export interface ArtifactDeps {
  readonly fs: FileSystem;
  readonly messageStore: DialogStore;
}

export async function auditSubagentArtifactCompleteness(
  s: ArtifactSnapshot,
  deps: ArtifactDeps,
  audit: AuditLog,
): Promise<void> {
  // AC-4: messageStore 末轮 assistant ↔ textEndCount > 0
  try {
    const result = await deps.messageStore.load();
    if (result.source === 'io_error') {
      audit.write(
        SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_SKIPPED,
        `kind=ac4_skip`, `agentId=${s.agentId}`,
        `reason=message_load_io_error`, `error=${result.error}`,
      );
      return;
    }
    const messages = result.session.messages;
    const last = messages.at(-1);
    const lastIsAssistant = last?.role === 'assistant';
    const lastHasContent = lastIsAssistant && Array.isArray(last.content)
      ? last.content.some((b: { type?: string }) => b.type === 'text')
      : (lastIsAssistant && typeof last?.content === 'string' && (last.content as string).length > 0);
    if (s.textEndCount > 0 && !lastHasContent) {
      audit.write(
        SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_MISMATCH,
        `kind=ac4_textend_without_last_assistant_text`,
        `agentId=${s.agentId}`,
        `textend_count=${s.textEndCount}`,
        `last_role=${last?.role ?? 'none'}`,
      );
    }
  } catch (err) {
    audit.write(
      SUBAGENT_AUDIT_EVENTS.SUBAGENT_ARTIFACT_CROSS_SOURCE_SKIPPED,
      `kind=ac4_skip`, `agentId=${s.agentId}`,
      `reason=message_load_failed`, `error=${formatErr(err)}`,
    );
  }
}
