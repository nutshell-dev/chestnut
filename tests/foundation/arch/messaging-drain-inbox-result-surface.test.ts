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

describe('Messaging DrainInboxResult deep surface', () => {
  it('keeps the drain result interface local behind InboxReader', () => {
    expect(inboxReaderSource).not.toMatch(/export\s+interface\s+DrainInboxResult\s*\{/);
    expect(inboxReaderSource).toMatch(
      /(?:^|\n)interface\s+DrainInboxResult\s*\{\s*\bentries:\s*InboxEntry\[\];\s*\btransientErrors:\s*number;[\s\S]*?\bpermanentErrors:\s*number;[\s\S]*?\}/,
    );
    expect(inboxReaderSource).toMatch(/async\s+drainInbox\(\):\s*Promise<DrainInboxResult>\s*\{/);
    expect(inboxReaderSource).toMatch(
      /private\s+_toDrainResult\(view:\s*PendingView\):\s*DrainInboxResult\s*\{/,
    );
    expect(barrelSource).not.toMatch(/\bDrainInboxResult\b/);
  });
});
