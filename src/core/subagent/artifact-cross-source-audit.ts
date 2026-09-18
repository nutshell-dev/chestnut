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

import type { FileSystem } from '../../foundation/fs/index.js';
import type { DialogStore } from '../../foundation/dialog-store/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import type { SubAgentLifecycleSink } from './lifecycle-sink.js';

export interface ArtifactSnapshot {
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
  sink: SubAgentLifecycleSink,
): Promise<void> {
  // AC-4: messageStore 末轮 assistant ↔ textEndCount > 0
  try {
    const result = await deps.messageStore.load();
    if (result.source === 'io_error') {
      sink.artifactCrossSourceSkipped({
        kind: 'ac4_skip',
        reason: 'message_load_io_error',
        error: result.error,
      });
      return;
    }
    const messages = result.session.messages;
    const last = messages.at(-1);
    const lastIsAssistant = last?.role === 'assistant';
    const lastHasContent = lastIsAssistant && Array.isArray(last.content)
      ? last.content.some((b: { type?: string }) => b.type === 'text')
      : (lastIsAssistant && typeof last?.content === 'string' && (last.content as string).length > 0);
    if (s.textEndCount > 0) {
      if (!lastHasContent) {
        sink.artifactCrossSourceMismatch({
          textEndCount: s.textEndCount,
          lastRole: last?.role ?? 'none',
        });
      } else {
        // phase 1858 Step D (SA-D3): 检查执行即持久化结论（pass 分支可见）
        sink.artifactCrossSourceOk({
          textEndCount: s.textEndCount,
          lastRole: last?.role ?? 'none',
        });
      }
    }
  } catch (err) {
    sink.artifactCrossSourceSkipped({
      kind: 'ac4_skip',
      reason: 'message_load_failed',
      error: formatErr(err),
    });
  }
}
