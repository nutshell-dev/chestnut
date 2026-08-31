import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const reconcilerSource = readFileSync(
  new URL('../../../src/core/contract/jobs/archive-reconciler.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract ArchiveReconcilerContext deep surface', () => {
  it('keeps the reconciler context type local behind the reconciler entry', () => {
    expect(reconcilerSource).not.toMatch(/export\s+interface\s+ArchiveReconcilerContext\b/);
    expect(reconcilerSource).toMatch(
      /(?:^|\n)interface\s+ArchiveReconcilerContext\s*\{\s*\n\s*fs:\s*FileSystem;\s*\n\s*audit:\s*AuditLog;\s*\n\}/,
    );
    expect(reconcilerSource).toMatch(
      /export\s+async\s+function\s+reconcileArchiveStaleEntries\(\s*\n\s*ctx:\s*ArchiveReconcilerContext,/,
    );
    expect(barrelSource).not.toMatch(/\bArchiveReconcilerContext\b/);
  });
});
