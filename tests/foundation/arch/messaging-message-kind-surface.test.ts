import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const invariantsSource = readFileSync(
  new URL('../../../src/foundation/messaging/invariants.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/foundation/messaging/index.ts', import.meta.url),
  'utf8',
);

describe('Messaging MessageKind deep surface', () => {
  it('keeps the message kind type local behind assertMessageShape', () => {
    expect(invariantsSource).not.toMatch(/export\s+type\s+MessageKind\b/);
    expect(invariantsSource).toMatch(
      /(?:^|\n)type\s+MessageKind\s*=\s*'inbox'\s*\|\s*'outbox';/,
    );
    expect(invariantsSource).toMatch(/(?:^|\n)\s*kind:\s*MessageKind,/);
    expect(invariantsSource).toMatch(
      /function\s+checkId\(m:\s*Record<string,\s*unknown>,\s*audit:\s*AuditLog,\s*kind:\s*MessageKind,/,
    );
    expect(barrelSource).not.toMatch(/\bMessageKind\b/);
  });
});
