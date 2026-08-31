import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditEmitSource = readFileSync(
  new URL('../../../src/core/contract/audit-emit.ts', import.meta.url),
  'utf8',
);

describe('Contract emitContractRollbackFailed dead surface', () => {
  it('has no emitContractRollbackFailed anywhere in the audit-emit source', () => {
    expect(auditEmitSource).not.toMatch(/\bemitContractRollbackFailed\b/);
  });

  it('keeps a stable live emit anchor intact', () => {
    expect(auditEmitSource).toMatch(/export\s+function\s+emitContractCreated\(/);
  });
});
