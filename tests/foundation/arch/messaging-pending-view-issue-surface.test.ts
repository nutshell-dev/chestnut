import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const inboxReaderSource = readFileSync(
  new URL('../../../src/foundation/messaging/inbox-reader.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging PendingViewIssue deep surface', () => {
  it('keeps the pending view issue type local behind InboxReader', () => {
    expect(inboxReaderSource).not.toMatch(/export\s+type\s+PendingViewIssue\b/);
    expect(inboxReaderSource).toMatch(
      /(?:^|\n)type\s+PendingViewIssue\s*=\s*\|\s*\{\s*kind:\s*'transient_read';[\s\S]*?\}\s*\|\s*\{\s*kind:\s*'malformed';[\s\S]*?\}\s*\|\s*\{\s*kind:\s*'duplicate';[\s\S]*?\};/,
    );
    expect(inboxReaderSource).toMatch(/(?:^|\n)\s*issues:\s*PendingViewIssue\[\];/);
    expect(inboxReaderSource).toMatch(
      /private\s+async\s+_applyPendingIssues\(issues:\s*PendingViewIssue\[\]\)/,
    );
    expect(barrelSource).not.toMatch(/\bPendingViewIssue\b/);
  });
});
