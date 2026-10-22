/**
 * DialogStore shape invariants (phase 227)
 */

import { describe, it, expect } from 'vitest';

import type { Message } from '../../../src/foundation/dialog-store/index.js';
import { makeAudit } from '../../helpers/audit.js';
import { assertDialogShapeInvariants } from '../../../src/foundation/dialog-store/invariants.js';
import { DIALOG_AUDIT_EVENTS } from '../../../src/foundation/dialog-store/audit-events.js';
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('dialog shape invariants (phase 227)', () => {
  describe('不变量 1：连续 plain user chat', () => {
    it('正常 user/assistant 交替 0 audit emit', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED)).toHaveLength(0);
    });

    it('连续 2 plain user chat → emit DIALOG_INVARIANT_VIOLATED kind=consecutive_plain_user_chat', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ];
      assertDialogShapeInvariants(messages, audit);
      const evts = events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED);
      expect(evts.length).toBeGreaterThanOrEqual(1);
      expect(evts.some(e => e.some(c => String(c).includes('consecutive_plain_user_chat')))).toBe(true);
    });

    it('user(tool_result) + user(plain) 不算连续 plain user chat', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        { role: 'user', content: 'next' },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e =>
        e.some(c => String(c).includes('consecutive_plain_user_chat'))
      )).toBe(false);
    });

    it('连续 3+ plain user chat 只 emit 一次', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'user', content: 'c' },
      ];
      assertDialogShapeInvariants(messages, audit);
      const evts = events.filter(e =>
        e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED &&
        e.some(c => String(c).includes('consecutive_plain_user_chat'))
      );
      expect(evts).toHaveLength(1);
    });
  });

  describe('不变量 2：tool_use / tool_result 配对', () => {
    it('正常配对 0 audit emit', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.filter(e => e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED)).toHaveLength(0);
    });

    it('孤悬 tool_use（无 tool_result）→ emit orphan_tool_use', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e =>
        e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED &&
        e.some(c => String(c).includes('orphan_tool_use')) &&
        e.some(c => String(c).includes('tool_use_id=t1'))
      )).toBe(true);
    });

    it('孤悬 tool_result（无 tool_use）→ emit orphan_tool_result', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e =>
        e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED &&
        e.some(c => String(c).includes('orphan_tool_result')) &&
        e.some(c => String(c).includes('tool_use_id=t1'))
      )).toBe(true);
    });

    it('多个孤悬 tool_use 各 emit 一次', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'exec', input: {} },
          { type: 'tool_use', id: 't2', name: 'exec', input: {} },
        ]},
      ];
      assertDialogShapeInvariants(messages, audit);
      const evts = events.filter(e =>
        e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED &&
        e.some(c => String(c).includes('orphan_tool_use'))
      );
      expect(evts).toHaveLength(2);
    });

    it('phase 918: tool_result 出现在对应 tool_use 之前 → audit tool_result_before_tool_use', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e =>
        e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED &&
        e.some(c => String(c).includes('tool_result_before_tool_use')) &&
        e.some(c => String(c).includes('tool_use_id=t1')) &&
        e.some(c => String(c).includes('tool_use_idx=1')) &&
        e.some(c => String(c).includes('tool_result_idx=0'))
      )).toBe(true);
    });

    it('phase 918: 配对正常但顺序正确时不 emit tool_result_before_tool_use', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e =>
        e.some(c => String(c).includes('tool_result_before_tool_use'))
      )).toBe(false);
    });
  });

  describe('不变量 3：tool_use / tool_result 邻接', () => {
    it('紧邻配对 0 adjacency emit', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e => e.some(c => String(c).includes('tool_use_result_not_adjacent')))).toBe(false);
    });

    it('摘要夹在 assistant tool_use 与 tool_result 之间 → emit not_adjacent', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'send', input: {} }] },
        { role: 'user', content: '[context-trim summary] boundary' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      const evt = events.find(e =>
        e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED &&
        e.some(c => String(c).includes('kind=tool_use_result_not_adjacent')),
      );
      expect(evt).toBeDefined();
      expect(evt?.some(c => String(c).includes('tool_use_id=t1'))).toBe(true);
      expect(evt?.some(c => String(c).includes('tool_use_idx=0'))).toBe(true);
      expect(evt?.some(c => String(c).includes('next_idx=1'))).toBe(true);
    });

    it('text + tool_result 同一 user 消息不算邻接断裂', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
        { role: 'user', content: [
          { type: 'text', text: 'note' },
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
        ] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e => e.some(c => String(c).includes('tool_use_result_not_adjacent')))).toBe(false);
    });

    it('多个结果分散在连续 user 消息中不算断裂', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'exec', input: {} },
          { type: 'tool_use', id: 't2', name: 'exec', input: {} },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e => e.some(c => String(c).includes('tool_use_result_not_adjacent')))).toBe(false);
    });

    it('result 前出现 assistant 消息 → emit not_adjacent', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
        { role: 'assistant', content: 'intervening' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e => e.some(c => String(c).includes('tool_use_result_not_adjacent')))).toBe(true);
    });

    it('尾部未配对 tool_use 只归 orphan_tool_use，不重复 emit adjacency', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'exec', input: {} }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      expect(events.some(e => e.some(c => String(c).includes('orphan_tool_use')))).toBe(true);
      expect(events.some(e => e.some(c => String(c).includes('tool_use_result_not_adjacent')))).toBe(false);
    });

    it('多 tool_use 只对仍未配对的 id emit', () => {
      const { audit, events } = makeAudit();
      const messages: Message[] = [
        { role: 'assistant', content: [
          { type: 'tool_use', id: 't1', name: 'exec', input: {} },
          { type: 'tool_use', id: 't2', name: 'exec', input: {} },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        { role: 'user', content: '[context-trim summary] boundary' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] },
      ];
      assertDialogShapeInvariants(messages, audit);
      const adjacencyEvents = events.filter(e => e.some(c => String(c).includes('tool_use_result_not_adjacent')));
      expect(adjacencyEvents).toHaveLength(1);
      expect(adjacencyEvents[0].some(c => String(c).includes('tool_use_id=t2'))).toBe(true);
      expect(adjacencyEvents[0].some(c => String(c).includes('tool_use_id=t1'))).toBe(false);
    });
  });

  describe('phase 224 fixture 重放', () => {
    it('fixture 在末段连续 user chat 处 emit consecutive_plain_user_chat', () => {
      const { audit, events } = makeAudit();
      const fixturePath = path.join(__dirname, 'fixtures', 'phase224-motion-dialog.json');
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
      assertDialogShapeInvariants(fixture.messages, audit);
      expect(events.some(e =>
        e[0] === DIALOG_AUDIT_EVENTS.DIALOG_INVARIANT_VIOLATED &&
        e.some(c => String(c).includes('consecutive_plain_user_chat'))
      )).toBe(true);
    });
  });
});
