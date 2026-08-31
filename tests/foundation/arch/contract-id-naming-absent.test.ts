import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditEventsSource = readFileSync(
  new URL('../../../src/core/contract/audit-events.ts', import.meta.url),
  'utf8',
);

describe('Contract CONTRACT_ID_NAMING dead surface', () => {
  it('has no CONTRACT_ID_NAMING anywhere in the audit-events source', () => {
    expect(auditEventsSource).not.toMatch(/\bCONTRACT_ID_NAMING\b/);
  });

  it('keeps a stable live event table anchor intact', () => {
    expect(auditEventsSource).toMatch(/export\s+const\s+CONTRACT_AUDIT_EVENTS\b/);
  });
});
