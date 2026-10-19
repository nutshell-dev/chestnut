/**
 * Phase 1955 Step C：失败 turn 保留 checkpoint 后，同一 inbox 消息重投递时
 * 不得在 dialog 中重复成第二条 user message。按稳定 inboxId 去重。
 */

import type { Message } from '../../foundation/dialog-store/index.js';

export function dedupeReinjectedInboxMessages(
  sessionMessages: readonly Message[],
  injected: readonly Message[],
): Message[] {
  const persisted = new Set(
    sessionMessages
      .map(message => message.inboxId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  return injected.filter(
    message => message.inboxId === undefined || !persisted.has(message.inboxId),
  );
}
