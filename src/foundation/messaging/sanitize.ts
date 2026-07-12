/**
 * Messaging boundary sanitization helpers.
 *
 * These functions are the single source of truth for validating external input
 * before it reaches the messaging wire format or filesystem paths. They are
 * intentionally strict: callers with unsafe data must fail loudly rather than
 * silently corrupt files or inject YAML.
 */

/** Characters safe for use in filesystem paths — letters, digits, underscore, hyphen. */
const SAFE_MESSAGE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate and return a message identifier safe for filesystem use.
 * Throws if the identifier contains path separators, special characters, or is empty.
 *
 * Applied at InboxWriter boundary — any caller must pass valid identifiers.
 */
export function sanitizeMessageIdentifier(s: string, field: string): string {
  if (!s || !SAFE_MESSAGE_ID_RE.test(s)) {
    throw new Error(
      `Invalid message identifier in field '${field}': "${s}". ` +
        `Only alphanumeric characters, underscores, and hyphens are allowed.`,
    );
  }
  return s;
}

const UNSAFE_KEY_RE = /[\n\r:]|---/;

/**
 * Assert that a frontmatter key is safe for YAML-like encoding.
 * Keys must not contain newlines, colons, or the YAML document separator.
 * Throws on violation — caller has a bug, not a runtime condition.
 */
export function assertSafeKey(k: string): void {
  if (UNSAFE_KEY_RE.test(k)) {
    throw new Error(
      `Unsafe frontmatter key: "${k}". Keys must not contain newlines, colons, or "---".`,
    );
  }
}
