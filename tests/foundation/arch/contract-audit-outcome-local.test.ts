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

describe('Contract AuditOutcome deep surface', () => {
  it('keeps the audit outcome type local behind ContractAuditor methods', () => {
    expect(auditorSource).not.toMatch(/export\s+interface\s+AuditOutcome\b/);
    expect(auditorSource).toMatch(
      /(?:^|\n)interface\s+AuditOutcome\s*\{\s*\n\s*audited:\s*boolean;\s*\n\s*verdict\?:\s*AuditorVerdict;/,
    );
    expect(auditorSource).toMatch(
      /async\s+maybeAudit\(req:\s*AuditRequest\):\s*Promise<AuditOutcome>/,
    );
    expect(barrelSource).not.toMatch(/\bAuditOutcome\b/);
  });
});
