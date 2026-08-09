import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

describe('phase 1350: Messaging public surface ratchet', () => {
  const barrel = fs.readFileSync('src/foundation/messaging/index.ts', 'utf8');
  const types = fs.readFileSync('src/foundation/messaging/types.ts', 'utf8');
  const sdk = fs.readFileSync('src/index.ts', 'utf8');

  it('keeps PRIORITY_VALUES owner-internal while preserving its definition', () => {
    expect(barrel).not.toMatch(/\bPRIORITY_VALUES\b/);
    expect(types).toMatch(/export const PRIORITY_VALUES\b/);
  });

  it('preserves OutboxMessage as a Messaging and root SDK protocol type', () => {
    expect(barrel).toMatch(/\bOutboxMessage\b/);
    expect(sdk).toMatch(/export type \{[^}]*\bOutboxMessage\b[^}]*\} from ['"]\.\/foundation\/messaging\/index\.js['"]/s);
  });
});
