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

describe('Messaging PendingView deep surface', () => {
  it('keeps the pending view interface local behind InboxReader', () => {
    expect(inboxReaderSource).not.toMatch(/export\s+interface\s+PendingView\s*\{/);
    expect(inboxReaderSource).toMatch(
      /(?:^|\n)interface\s+PendingView\s*\{\s*\bentries:\s*InboxEntry\[\];\s*\bissues:\s*PendingViewIssue\[\];\s*\}/,
    );
    expect(inboxReaderSource).toMatch(/peekPending\(\):\s*Promise<PendingView>;/);
    expect(inboxReaderSource).toMatch(/constructor\(readonly\s+view:\s*PendingView\)/);
    expect(inboxReaderSource).toMatch(
      /private\s+async\s+_readPendingView\(opts\?:\s*\{\s*emitObservability\?:\s*boolean\s*\}\):\s*Promise<PendingView>/,
    );
    expect(inboxReaderSource).toMatch(/private\s+_toDrainResult\(view:\s*PendingView\)/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bPendingViewError\b[^}]*\}\s*from\s*'\.\/inbox-reader\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bPendingView\b/);
  });
});
