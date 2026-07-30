/**
 * phase 1243: InboxMessageTypeRegistry behavior invariants。
 *
 * Covers:
 * - register / resolve 基本路径
 * - 未注册 type resolve() = undefined（caller 负责 fallback）
 * - last-win 语义（重复注册以最后一次为准）
 * - 标准 presentation renderer（system / user_chat / user_inbox）
 * - custom formatter declaration
 */

import { describe, it, expect } from 'vitest';
import {
  createMessageFormatterRegistry,
  renderStandardInboxMessage,
  registerInboxMessageTypes,
} from '../../../src/foundation/messaging/index.js';
import type { MessageFormatter } from '../../../src/foundation/messaging/index.js';
import { MESSAGING_INBOX_MESSAGE_TYPES } from '../../../src/foundation/messaging/index.js';

describe('phase 1243 InboxMessageTypeRegistry', () => {
  it('register + resolve custom formatter happy path', async () => {
    const registry = createMessageFormatterRegistry();
    const f: MessageFormatter = async ({ body }) => `[OK] ${body}`;
    registry.register({ type: 'my_type', rendering: { kind: 'custom', formatter: f } });
    const got = registry.resolve('my_type');
    expect(got).toEqual({ kind: 'custom', formatter: f });
    const out = await (got as Extract<typeof got, { kind: 'custom' }>).formatter({ from: 'x', body: 'hi', timestampSec: '' });
    expect(out).toBe('[OK] hi');
  });

  it('unknown type resolve returns undefined', () => {
    const registry = createMessageFormatterRegistry();
    expect(registry.resolve('never_registered')).toBeUndefined();
  });

  it('repeated register last-win semantics (装配期 idempotent)', async () => {
    const registry = createMessageFormatterRegistry();
    const f1: MessageFormatter = async () => 'first';
    const f2: MessageFormatter = async () => 'second';
    registry.register({ type: 'shared', rendering: { kind: 'custom', formatter: f1 } });
    registry.register({ type: 'shared', rendering: { kind: 'custom', formatter: f2 } });
    const got = registry.resolve('shared');
    expect(got?.kind).toBe('custom');
    const out = await (got as Extract<typeof got, { kind: 'custom' }>).formatter({ from: 'x', body: '', timestampSec: '' });
    expect(out).toBe('second');
  });

  it('standard system presentation', () => {
    const ctx = { from: 'sys', body: 'hello', timestampSec: ' (1m ago)' };
    expect(renderStandardInboxMessage(ctx, 'system')).toBe('[system message (1m ago)] hello');
  });

  it('standard user_inbox presentation', () => {
    const ctx = { from: 'user', body: 'hello', timestampSec: ' (2m ago)' };
    expect(renderStandardInboxMessage(ctx, 'user_inbox')).toBe('[user inbox message (2m ago)]\nhello');
  });

  it('standard user_chat presentation', () => {
    const ctx = { from: 'user', body: 'hello', timestampSec: '' };
    expect(renderStandardInboxMessage(ctx, 'user_chat')).toBe('hello');
  });

  it('registerInboxMessageTypes 立 Messaging 自家 user_inbox_message declaration (phase 9: message catch-all 拆除)', () => {
    const registry = createMessageFormatterRegistry();
    registerInboxMessageTypes(registry, MESSAGING_INBOX_MESSAGE_TYPES);

    const rendering = registry.resolve('user_inbox_message');
    expect(rendering).toEqual({ kind: 'standard', presentation: 'user_inbox' });

    // 'message' formatter 已 phase 9 移除
    expect(registry.resolve('message')).toBeUndefined();
  });
});
