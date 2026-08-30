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

describe('Messaging InboxLocation deep surface', () => {
  it('keeps the inbox location type local behind InboxReader', () => {
    expect(inboxReaderSource).not.toMatch(/export\s+type\s+InboxLocation\b/);
    expect(inboxReaderSource).toMatch(
      /(?:^|\n)type\s+InboxLocation\s*=\s*typeof\s+INBOX_LOCATIONS\[number\];/,
    );
    expect(inboxReaderSource).toMatch(
      /export\s+type\s+ScannedInboxLocation\s*=\s*Exclude<InboxLocation,\s*'failed'>;/,
    );
    expect(inboxReaderSource).toMatch(/(?:^|\n)\s*location:\s*InboxLocation,/);
    expect(barrelSource).toMatch(
      /export\s+type\s*\{[^}]*\bScannedInboxLocation\b[^}]*\}\s*from\s*'\.\/inbox-reader\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bInboxLocation\b/);
  });
});
