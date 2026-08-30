import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/migration-journal.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('AuditMigrationJournal surface', () => {
  it('keeps the journal assembly carrier local behind migration operations', () => {
    expect(source).not.toMatch(/export\s+interface\s+AuditMigrationJournal\b/);
    expect(source).toMatch(/interface\s+AuditMigrationJournal\s*\{[\s\S]*intent\?:\s*AuditMigrationIntent;[\s\S]*outcome\?:\s*AuditMigrationOutcome;[\s\S]*\}/);
    expect(source).toMatch(/readAuditMigrationJournal\([\s\S]*?\):\s*AuditMigrationJournal/);
    expect(source).toMatch(/const\s+journal:\s*AuditMigrationJournal\s*=\s*\{\}/);
    expect(barrel).not.toMatch(/\bAuditMigrationJournal\b/);
  });
});
