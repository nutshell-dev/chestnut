import type { OutboxMessage } from '../messaging/types.js';

/**
 * Encode OutboxMessage to markdown string.
 * Pure function: no I/O, no side effects.
 */
export function encodeOutbox(msg: OutboxMessage): string {
  const metadataLines = msg.metadata
    ? Object.entries(msg.metadata).map(([k, v]) => `**${k.charAt(0).toUpperCase() + k.slice(1)}:** ${v}`)
    : [];
  const lines = [
    `# ${msg.type.toUpperCase()}`,
    '',
    `**From:** ${msg.from}`,
    `**To:** ${msg.to}`,
    `**Time:** ${msg.timestamp}`,
    ...metadataLines,
    '',
    '---',
    '',
    msg.content,
  ];

  return lines.filter(l => l !== null && l !== undefined).join('\n');
}
