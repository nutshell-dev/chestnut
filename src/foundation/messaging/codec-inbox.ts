import { randomUUID } from 'crypto';
import type { InboxMessage } from '../messaging/types.js';
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
export function yamlQuote(v: string): string {
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

  if (msg.reply_to !== undefined) {
    lines.push(`reply_to: ${yamlQuote(msg.reply_to)}`);
  }

  // Generic metadata pass-through
  if (msg.metadata) {
    const reserved = new Set(['id', 'type', 'from', 'to', 'priority', 'timestamp']);
    for (const [k, v] of Object.entries(msg.metadata)) {
      if (!reserved.has(k) && !k.startsWith('__')) {
        lines.push(`${k}: ${yamlQuote(v)}`);
      }
    }
  }

  // Append extra fields, guard against overriding standard keys
  if (extraFields) {
    const reserved = new Set(['id', 'type', 'from', 'to', 'priority', 'timestamp']);
    for (const [k, v] of Object.entries(extraFields)) {
      if (reserved.has(k)) {
        // silent: field conflict skipped — no audit channel in codec (pure function)
        continue;
      }
      lines.push(`${k}: ${yamlQuote(v)}`);
    }
  }

  // Write out extraMeta fields (non __-prefixed), extraFields + metadata takes precedence
  if (msg.extraMeta) {
    const reservedAndExtra = new Set([
      'id', 'type', 'from', 'to', 'priority', 'timestamp',
      ...(extraFields ? Object.keys(extraFields) : []),
      ...(msg.metadata ? Object.keys(msg.metadata) : []),
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

  const baseKeys = new Set(['id', 'type', 'from', 'source', 'to', 'content',
    'priority', 'timestamp', 'reply_to']);

  // Generic metadata pass-through (non-base keys excluding internal __-prefixed)
  const metadata: Record<string, string> = {};
  const extraMeta: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!baseKeys.has(k)) {
      if (k.startsWith('__')) {
        extraMeta[k] = v;
      } else if (k !== 'claw_id') {
        metadata[k] = v;
      }
    }
  }

  // A.2: priority 违规原值保存
  const rawPriority = meta.priority;
  const priority = validatePriority(rawPriority);
  if (rawPriority !== undefined && priority !== rawPriority) {
    extraMeta.__original_priority = rawPriority;
  }

  // A.3: legacy claw_id field observability (generic metadata pass-through)
  if (meta.claw_id !== undefined) {
    extraMeta.__legacy_claw_id = meta.claw_id;
  }

  // type loose validation（M9 phase 575）/ 任意 string 直通 / 非 string fallback 'message'
  const rawType = meta.type;
  const type = validateType(rawType);
  if (rawType !== undefined && typeof rawType !== 'string') {
    extraMeta.__original_type = String(rawType);   // 非 string 输入仍记原值
  }

  const result: InboxMessage = {
    id: meta.id ?? randomUUID(),
    type,
    from: meta.from ?? meta.source ?? 'unknown',
    to: meta.to ?? '',
    content: body,
    priority,
    timestamp: meta.timestamp ?? new Date().toISOString(),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(Object.keys(extraMeta).length > 0 ? { extraMeta } : {}),
  };

  if (meta.reply_to !== undefined) {
    result.reply_to = meta.reply_to;
  }

  return result;
}
