import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.cwd(), 'src');
const MESSAGING = path.join(SRC, 'foundation', 'messaging');
const FORBIDDEN = /\b(?:__internal_create|makeInboxPath|makeOutboxPath|resolveDlqDir|INBOX_PENDING_DIR|INBOX_INFLIGHT_DIR|INBOX_MISROUTED_DIR|INBOX_DONE_DIR|INBOX_FAILED_DIR|OUTBOX_PENDING_DIR|OUTBOX_DONE_DIR|OUTBOX_FAILED_DIR|OUTBOX_PROCESSING_DIR)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}

describe('Phase 2147 B2 Messaging leaf ownership ratchet', () => {
  it('does not re-export leaf constants or legacy leaf constructors from the barrel', () => {
    const barrel = readFileSync(path.join(MESSAGING, 'index.ts'), 'utf8');
    expect(barrel).not.toMatch(FORBIDDEN);
    expect(barrel).toMatch(/createInboxWriter/);
    expect(barrel).toMatch(/initializeMessagingLayout/);
  });

  it('keeps legacy leaf APIs and leaf constants inside the Messaging owner', () => {
    const violations = sourceFiles(SRC)
      .filter(file => !file.startsWith(MESSAGING + path.sep))
      .filter(file => FORBIDDEN.test(readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC, file));
    expect(violations).toEqual([]);
  });
});
