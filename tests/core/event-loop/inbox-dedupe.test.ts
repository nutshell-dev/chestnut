import { describe, it, expect } from 'vitest';
import { dedupeReinjectedInboxMessages } from '../../../src/core/event-loop/inbox-dedupe.js';
import type { Message } from '../../../src/foundation/dialog-store/index.js';

function msg(content: string, inboxId?: string): Message {
  return { role: 'user', content, ...(inboxId !== undefined ? { inboxId } : {}) };
}

describe('Phase 1955 Step C: resume 重投递去重', () => {
  it('已在 dialog 的 inboxId 不再注入第二条', () => {
    const session = [msg('task', 'msg-1'), msg('step-1 done')];
    const injected = [msg('task (2m ago)', 'msg-1')];

    expect(dedupeReinjectedInboxMessages(session, injected)).toEqual([]);
  });

  it('新 inboxId 与无身份消息照常注入', () => {
    const session = [msg('task', 'msg-1')];
    const injected = [msg('task retry', 'msg-1'), msg('new user message', 'msg-2'), msg('system note')];

    expect(dedupeReinjectedInboxMessages(session, injected)).toEqual([
      msg('new user message', 'msg-2'),
      msg('system note'),
    ]);
  });

  it('空 session 不删除任何注入消息', () => {
    const injected = [msg('task', 'msg-1')];
    expect(dedupeReinjectedInboxMessages([], injected)).toEqual(injected);
  });
});
