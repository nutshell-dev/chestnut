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

describe('Messaging MessageDirection deep surface', () => {
  it('keeps the message direction type local behind assertMessageShape', () => {
    expect(invariantsSource).not.toMatch(/export\s+type\s+MessageDirection\b/);
    expect(invariantsSource).toMatch(
      /(?:^|\n)type\s+MessageDirection\s*=\s*'write';/,
    );
    expect(invariantsSource).toMatch(/(?:^|\n)\s*direction:\s*MessageDirection,/);
    expect(invariantsSource).toMatch(
      /function\s+checkId\(m:\s*Record<string,\s*unknown>,\s*audit:\s*AuditLog,\s*kind:\s*MessageKind,\s*direction:\s*MessageDirection\)/,
    );
    expect(barrelSource).not.toMatch(/\bMessageDirection\b/);
  });
});
