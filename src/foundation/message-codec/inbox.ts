import { randomUUID } from 'crypto';
import type { InboxMessage } from '../../types/contract.js';
import { parseFrontmatter } from './frontmatter.js';
import { validatePriority, validateType } from './validation.js';

/**
 * Quote a value for safe YAML insertion.
 */
function yamlQuote(v: string): string {
  if (/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false') return v;
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
}

/**
 * Encode InboxMessage to YAML frontmatter + body string.
 * Pure function: no I/O, no side effects.
 */
export function encodeInbox(
  msg: InboxMessage,
  extraFields?: Record<string, string>,
): string {
  const lines = [
    '---',
    `id: ${msg.id}`,
    `type: ${msg.type}`,
    `from: ${yamlQuote(msg.from)}`,
    `to: ${yamlQuote(msg.to)}`,
    `priority: ${msg.priority}`,
    `timestamp: ${msg.timestamp}`,
  ];

  if (msg.contract_id) {
    lines.push(`contract_id: ${yamlQuote(msg.contract_id)}`);
  }

  // Append extra fields
  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) {
      lines.push(`${k}: ${yamlQuote(v)}`);
    }
  }

  lines.push('---', '', msg.content, '');
  return lines.join('\n');
}

/**
 * Decode raw string to InboxMessage.
 * Reads `from` field, falls back to `source` for backward compatibility.
 * Fills missing fields with defaults.
 */
export function decodeInbox(raw: string): InboxMessage {
  const { meta, body } = parseFrontmatter(raw);

  return {
    id: meta.id ?? randomUUID(),
    type: validateType(meta.type),
    from: meta.from ?? meta.source ?? 'unknown',
    to: meta.to ?? '',
    content: body,
    priority: validatePriority(meta.priority),
    timestamp: meta.timestamp ?? new Date().toISOString(),
    contract_id: meta.claw_id ?? meta.contract_id,
  };
}
