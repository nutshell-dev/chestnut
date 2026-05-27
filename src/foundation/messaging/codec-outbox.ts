import type { OutboxMessage } from '../messaging/types.js';
import { yamlQuote } from './codec-inbox.js';

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
        lines.push(`${k}: ${yamlQuote(v)}`);
      }
    }
  }

  lines.push('---', '', msg.content, '');
  return lines.join('\n');
}
