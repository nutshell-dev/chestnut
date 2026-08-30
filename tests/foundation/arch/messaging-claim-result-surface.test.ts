import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const outboxReaderSource = readFileSync(
  new URL('../../../src/foundation/messaging/outbox-reader.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging ClaimResult deep surface', () => {
  it('keeps the claim result type local behind OutboxReader', () => {
    expect(outboxReaderSource).not.toMatch(/export\s+type\s+ClaimResult\b/);
    expect(outboxReaderSource).toMatch(
      /(?:^|\n)type\s+ClaimResult\s*=\s*\|\s*\{\s*status:\s*'empty'\s*\}\s*\|\s*\{\s*status:\s*'race_lost';\s*error:\s*string\s*\}\s*\|\s*\{\s*status:\s*'io_error';\s*error:\s*string\s*\}\s*\|\s*\{\s*status:\s*'claimed';\s*claimPath:\s*string;\s*filename:\s*string;\s*content:\s*string\s*\};/,
    );
    expect(outboxReaderSource).toMatch(
      /async\s+claimNext\(clawDir:\s*string\):\s*Promise<ClaimResult>\s*\{/,
    );
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bOutboxReader\b[^}]*\}\s*from\s*'\.\/outbox-reader\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bClaimResult\b/);
  });
});
