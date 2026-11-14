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
  it('keeps ClaimResult local and requires root-bound branded handles', () => {
    expect(outboxReaderSource).not.toMatch(/export\s+type\s+ClaimResult\b/);
    expect(outboxReaderSource).toMatch(/OutboxClaimHandle\s+&\s*\{\s*status:\s*'claimed'/);
    expect(outboxReaderSource).toMatch(/handle:\s*OutboxClaimHandle/);
    expect(outboxReaderSource).toMatch(
      /async\s+claimNext\(\s*opts:\s*\{\s*readContent\?:\s*boolean\s*\}\s*=\s*\{\},\s*\):\s*Promise<ClaimResult>/,
    );
    expect(outboxReaderSource).not.toMatch(/claimNext\(\s*clawDir:/);
    expect(outboxReaderSource).toMatch(/mintedClaims\s*=\s*new\s+WeakSet/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bOutboxReader\b[^}]*\bcreateOutboxReader\b[^}]*\}\s*from\s*'\.\/outbox-reader\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bClaimResult\b/);
  });
});
