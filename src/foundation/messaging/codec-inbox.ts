import { randomUUID } from 'crypto';
import type { InboxMessage } from '../../types/messaging.js';
import { validatePriority, validateType } from './codec-validation.js';

/**
 * Parse YAML frontmatter — module-level helper / shared by encodeInbox/decodeInbox + InboxWriter.readMeta.
 * Returns meta + body. Throws if frontmatter is malformed.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  // Normalize CRLF to LF for consistent parsing
  const normalized = raw.replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) return { meta: {}, body: raw };
  const afterOpen = normalized.slice(4);
  const closeIdx = afterOpen.indexOf('\n---\n');
  if (closeIdx < 0) {
    throw new Error('Malformed frontmatter: missing closing ---');
  }

  const meta: Record<string, string> = {};
  for (const line of afterOpen.slice(0, closeIdx).split('\n')) {
    const ci = line.indexOf(':');
    if (ci <= 0) continue;
    const key = line.slice(0, ci).trim();
    const value = yamlUnquote(line.slice(ci + 1).trim());
    meta[key] = value;
  }

  // Everything after the closing --- is the body
  return { meta, body: afterOpen.slice(closeIdx + 5).trim() };
}

/**
 * Reverse of yamlQuote — strip outer quotes + unescape `\\` `"` `\n` `\r`.
 * Non-quoted value returned verbatim (numeric / boolean literal).
 *
 * NUL placeholder 三段 replace 模式：
 * - `\\\\` → \x00 占位（防后续 replace 误踩 `\\n` 看到 escaped backslash）
 * - `\\"` / `\\n` / `\\r` 顺序 unescape
 * - \x00 → `\\` 还原
 */
function yamlUnquote(v: string): string {
  if (!(v.startsWith('"') && v.endsWith('"'))) return v;
  return v.slice(1, -1)
    .replace(/\\\\/g, '\x00')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\x00/g, '\\');
}

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
 *
 * Body content is written verbatim — no escaping needed because parseFrontmatter
 * uses the FIRST `\n---\n` as the closing delimiter, and all frontmatter values
 * are single-line (yamlQuote ensures this).
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
    `priority: ${validatePriority(msg.priority)}`,
    `timestamp: ${msg.timestamp}`,
  ];

  if (msg.contract_id) {
    lines.push(`contract_id: ${yamlQuote(msg.contract_id)}`);
  }

  // Append extra fields, guard against overriding standard keys
  if (extraFields) {
    const reserved = new Set(['id', 'type', 'from', 'to', 'priority', 'timestamp']);
    for (const [k, v] of Object.entries(extraFields)) {
      if (reserved.has(k)) {
        console.warn(`[Messaging] extraFields key "${k}" conflicts with standard field, skipping`);
        continue;
      }
      lines.push(`${k}: ${yamlQuote(v)}`);
    }
  }

  // Write out extraMeta fields (non __-prefixed), extraFields takes precedence
  if (msg.extraMeta) {
    const reservedAndExtra = new Set([
      'id', 'type', 'from', 'to', 'priority', 'timestamp',
      ...(extraFields ? Object.keys(extraFields) : []),
    ]);
    for (const [k, v] of Object.entries(msg.extraMeta)) {
      if (!reservedAndExtra.has(k) && !k.startsWith('__')) {
        lines.push(`${k}: ${yamlQuote(v)}`);
      }
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
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    throw new Error('Invalid inbox message: missing YAML frontmatter');
  }

  const { meta, body } = parseFrontmatter(raw);

  const knownKeys = new Set(['id', 'type', 'from', 'source', 'to', 'content',
    'priority', 'timestamp', 'contract_id', 'claw_id', 'reply_to']);

  // A.1: 收集未识别字段
  const extraMeta: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!knownKeys.has(k)) {
      extraMeta[k] = v;
    }
  }

  // A.2: priority 违规原值保存
  const rawPriority = meta.priority;
  const priority = validatePriority(rawPriority);
  if (rawPriority !== undefined && priority !== rawPriority) {
    extraMeta.__original_priority = rawPriority;
  }

  // type loose validation（M9 phase 575）/ 任意 string 直通 / 非 string fallback 'message'
  const rawType = meta.type;
  const type = validateType(rawType);
  if (rawType !== undefined && typeof rawType !== 'string') {
    extraMeta.__original_type = String(rawType);   // 非 string 输入仍记原值
  }

  return {
    id: meta.id ?? randomUUID(),
    type,
    from: meta.from ?? meta.source ?? 'unknown',
    to: meta.to ?? '',
    content: body,
    priority,
    timestamp: meta.timestamp ?? new Date().toISOString(),
    contract_id: meta.claw_id ?? meta.contract_id,
    ...(Object.keys(extraMeta).length > 0 ? { extraMeta } : {}),
  };
}
