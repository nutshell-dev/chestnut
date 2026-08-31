import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditorSource = readFileSync(
  new URL('../../../src/core/contract/contract-auditor.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract AuditRequest deep surface', () => {
  it('keeps the audit request type local behind ContractAuditor.maybeAudit', () => {
    expect(auditorSource).not.toMatch(/export\s+interface\s+AuditRequest\b/);
    expect(auditorSource).toMatch(
      /(?:^|\n)interface\s+AuditRequest\s*\{[\s\S]*?contractId:\s*string;[\s\S]*?auditInterval:\s*number;[\s\S]*?expectations:\s*string\s*\|\s*undefined;/,
    );
    expect(auditorSource).toMatch(
      /async\s+maybeAudit\(req:\s*AuditRequest\):\s*Promise<AuditOutcome>/,
    );
    expect(barrelSource).not.toMatch(/\bAuditRequest\b/);
  });
});
