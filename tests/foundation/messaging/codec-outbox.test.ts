import { describe, it, expect } from 'vitest';
import { encodeOutbox, decodeOutbox } from '../../../src/foundation/messaging/codec-outbox.js';
import { decodeInbox } from '../../../src/foundation/messaging/codec-inbox.js';
import type { OutboxMessage } from '../../../src/foundation/messaging/types.js';

describe('codec-outbox', () => {
  it('should encode outbox message to YAML frontmatter format', () => {
    const msg: OutboxMessage = {
      id: 'test-id',
      type: 'question',
      from: 'claw-a',
      to: 'motion',
      content: 'hello world',
      timestamp: '2026-01-01T00:00:00.000Z',
      priority: 'normal',
    };
    const result = encodeOutbox(msg);

    expect(result.startsWith('---\n')).toBe(true);
    expect(result).toContain('id: test-id');
    expect(result).toContain('type: question');
    expect(result).toContain('from: "claw-a"');
    expect(result).toContain('to: "motion"');
    expect(result).toContain('priority: normal');
    expect(result).toContain('timestamp: 2026-01-01T00:00:00.000Z');

    const bodyPart = result.split('\n---\n')[1];
    expect(bodyPart.trim()).toBe('hello world');
  });

  it('should roundtrip through decodeInbox', () => {
    const msg: OutboxMessage = {
      id: 'rt-id',
      type: 'response',
      from: 'claw-b',
      to: 'motion',
      content: 'roundtrip body',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'high',
    };
    const encoded = encodeOutbox(msg);
    const decoded = decodeInbox(encoded);

    expect(decoded.id).toBe(msg.id);
    expect(decoded.type).toBe(msg.type);
    expect(decoded.from).toBe(msg.from);
    expect(decoded.to).toBe(msg.to);
    expect(decoded.content).toBe(msg.content);
    expect(decoded.priority).toBe(msg.priority);
  });

  it('should handle metadata fields', () => {
    const msg: OutboxMessage = {
      id: 'meta-id',
      type: 'contract_update',
      from: 'claw-a',
      to: 'claw-b',
      content: 'update content',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'normal',
      metadata: { contract_id: 'abc-123', subtask_id: 'sub-1' },
    };
    const result = encodeOutbox(msg);

    expect(result).toContain('contract_id: "abc-123"');
    expect(result).toContain('subtask_id: "sub-1"');
  });

  it('should not include reserved fields from metadata', () => {
    const msg: OutboxMessage = {
      id: 'orig-id',
      type: 'question',
      from: 'orig-from',
      to: 'motion',
      content: 'test',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'low',
      metadata: { id: 'should-not-override', type: 'report', from: 'hijack' },
    };
    const result = encodeOutbox(msg);

    expect(result).toContain('id: orig-id');
    expect(result).toContain('from: "orig-from"');
    expect(result).toContain('type: question');
    expect(result).not.toContain('from: "hijack"');
    expect(result).not.toContain('id: should-not-override');
  });

  it('should yaml-quote values containing special chars', () => {
    const msg: OutboxMessage = {
      id: 'quote-id',
      type: 'question',
      from: 'claw "alpha"',
      to: 'motion',
      content: 'test',
      timestamp: '2026-05-26T12:00:00.000Z',
      priority: 'normal',
    };
    const result = encodeOutbox(msg);

    expect(result).toContain('from: "claw \\"alpha\\""');
  });

  // phase 1428 P5: decodeOutbox 镜像 decodeInbox 语义对称
  describe('decodeOutbox', () => {
    it('round-trips through encodeOutbox preserving base fields', () => {
      const msg: OutboxMessage = {
        id: 'rt-out',
        type: 'response',
        from: 'claw-b',
        to: 'motion',
        content: 'roundtrip outbox',
        timestamp: '2026-05-29T10:00:00.000Z',
        priority: 'high',
      };
      const decoded = decodeOutbox(encodeOutbox(msg));
      expect(decoded.id).toBe(msg.id);
      expect(decoded.type).toBe(msg.type);
      expect(decoded.from).toBe(msg.from);
      expect(decoded.to).toBe(msg.to);
      expect(decoded.content).toBe(msg.content);
      expect(decoded.priority).toBe(msg.priority);
      expect(decoded.timestamp).toBe(msg.timestamp);
    });

    it('passes through metadata fields (excluding reserved + __-prefixed)', () => {
      const msg: OutboxMessage = {
        id: 'meta-out',
        type: 'contract_update',
        from: 'claw-a',
        to: 'claw-b',
        content: 'body',
        timestamp: '2026-05-29T10:00:00.000Z',
        priority: 'normal',
        metadata: { contract_id: 'abc', subtask_id: 'sub-1' },
      };
      const decoded = decodeOutbox(encodeOutbox(msg));
      expect(decoded.metadata).toEqual({ contract_id: 'abc', subtask_id: 'sub-1' });
    });

    it('decodes in_reply_to when present in raw frontmatter', () => {
      const raw = [
        '---',
        'id: r1',
        'type: response',
        'from: a',
        'to: b',
        'priority: normal',
        'timestamp: 2026-05-29T10:00:00.000Z',
        'in_reply_to: orig-msg-id',
        '---',
        '',
        'body',
        '',
      ].join('\n');
      const decoded = decodeOutbox(raw);
      expect(decoded.in_reply_to).toBe('orig-msg-id');
    });

    it('throws on missing YAML frontmatter', () => {
      expect(() => decodeOutbox('no frontmatter body')).toThrow(/missing YAML frontmatter/);
    });

    it('fills defaults for absent base fields', () => {
      const raw = '---\npriority: normal\n---\n\nbare\n';
      const decoded = decodeOutbox(raw);
      expect(decoded.id).toBeTruthy();         // randomUUID fallback
      expect(decoded.from).toBe('unknown');
      expect(decoded.to).toBe('');
      expect(decoded.content).toBe('bare');
      expect(decoded.type).toBe('response');   // fallback default
    });
  });
});
