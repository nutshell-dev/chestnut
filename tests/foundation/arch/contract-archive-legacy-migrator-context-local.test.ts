import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migratorSource = readFileSync(
  new URL('../../../src/core/contract/jobs/archive-legacy-migrator.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract ArchiveLegacyMigratorContext deep surface', () => {
  it('keeps the migrator context type local behind the migrator entry', () => {
    expect(migratorSource).not.toMatch(/export\s+interface\s+ArchiveLegacyMigratorContext\b/);
    expect(migratorSource).toMatch(
      /(?:^|\n)interface\s+ArchiveLegacyMigratorContext\s*\{\s*\n\s*fs:\s*FileSystem;\s*\n\s*audit:\s*AuditLog;\s*\n\}/,
    );
    expect(migratorSource).toMatch(
      /export\s+async\s+function\s+migrateLegacyArchiveEntries\(\s*\n\s*ctx:\s*ArchiveLegacyMigratorContext,/,
    );
    expect(barrelSource).not.toMatch(/\bArchiveLegacyMigratorContext\b/);
  });
});
