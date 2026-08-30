import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const errorsSource = readFileSync(
  new URL('../../../src/foundation/messaging/errors.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging InboxMoveOp deep surface', () => {
  it('keeps the inbox move op type local behind InboxMoveFailed', () => {
    expect(errorsSource).not.toMatch(/export\s+type\s+InboxMoveOp\b/);
    expect(errorsSource).toMatch(
      /(?:^|\n)type\s+InboxMoveOp\s*=\s*'done'\s*\|\s*'failed'\s*\|\s*'ack_done'\s*\|\s*'nack_pending'\s*\|\s*'deliver_inflight'\s*\|\s*'reconcile_pending'\s*\|\s*'misrouted';/,
    );
    expect(errorsSource).toMatch(/public\s+readonly\s+op:\s*InboxMoveOp,/);
    expect(barrelSource).toMatch(
      /export\s*\{[^}]*\bInboxMoveFailed\b[^}]*\}\s*from\s*'\.\/errors\.js';/,
    );
    expect(barrelSource).not.toMatch(/\bInboxMoveOp\b/);
  });
});
