import type { OutboxMessage, Priority } from '../messaging/types.js';
import { parseFrontmatter, yamlQuote } from './codec-inbox.js';
import { validatePriority } from './codec-validation.js';
import { assertSafeKey } from './sanitize.js';
import { OutboxDecodeError } from './errors.js';

/**
 * Encode OutboxMessage to YAML frontmatter + body string.
 * Wire format align encodeInbox — single canonical format for messaging module (M#1).
 * Pure function: no I/O, no side effects.
 */
export function encodeOutbox(msg: OutboxMessage): string {
  const lines = [
    '---',
    `id: ${msg.id}`,
    `type: ${msg.type}`,
    `from: ${yamlQuote(msg.from)}`,
    `to: ${yamlQuote(msg.to)}`,
    `priority: ${msg.priority}`,
    `timestamp: ${msg.timestamp}`,
  ];

  if (msg.metadata) {
    const reserved = new Set(['id', 'type', 'from', 'to', 'priority', 'timestamp']);
    for (const [k, v] of Object.entries(msg.metadata)) {
      if (!reserved.has(k)) {
        assertSafeKey(k);
        lines.push(`${k}: ${yamlQuote(v)}`);
      }
    }
  }

  lines.push('---', msg.content);
  return lines.join('\n');
}

/**
 * Decode raw string to OutboxMessage. Mirror of decodeInbox for outbox files.
 * phase 1428: P5 — semantic symmetry, replaces decodeInbox borrowed by drain-outboxes (砍 by phase 1476).
 * Post phase 1476: only callers are CLI claw-outbox display + outbox-summary scanner (filename-only, no decode needed).
 * Reads base fields + in_reply_to + generic metadata pass-through.
 */
export function decodeOutbox(raw: string): OutboxMessage {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    throw new Error('Invalid outbox message: missing YAML frontmatter');
  }

  const { meta, body } = parseFrontmatter(raw);

  const baseKeys = new Set(['id', 'type', 'from', 'to', 'content',
    'priority', 'timestamp', 'in_reply_to']);

  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!baseKeys.has(k) && !k.startsWith('__')) {
      metadata[k] = v;
    }
  }

  if (!meta.id) throw new OutboxDecodeError('missing required field: id');

  // phase 929: validate type is a known enum value
  const VALID_OUTBOX_TYPES = new Set(['report', 'question', 'result', 'error']);
  if (!meta.type) throw new OutboxDecodeError('missing required field: type');
  if (!VALID_OUTBOX_TYPES.has(meta.type)) {
    throw new OutboxDecodeError(`invalid outbox type: "${meta.type}"`);
  }

  if (!meta.from) throw new OutboxDecodeError('missing required field: from');

  // phase 929: validate timestamp is parseable
  if (!meta.timestamp) throw new OutboxDecodeError('missing required field: timestamp');
  if (Number.isNaN(Date.parse(meta.timestamp))) {
    throw new OutboxDecodeError(`invalid outbox timestamp: "${meta.timestamp}"`);
  }

  const priority = validatePriority(meta.priority) as Priority;

  const result: OutboxMessage = {
    id: meta.id,
    type: meta.type as OutboxMessage['type'],
    from: meta.from,
    to: meta.to ?? '',
    content: body,
    timestamp: meta.timestamp,
    priority,
  };

  if (meta.in_reply_to !== undefined) {
    result.in_reply_to = meta.in_reply_to;
  }
  if (Object.keys(metadata).length > 0) {
    result.metadata = metadata;
  }

  return result;
}
