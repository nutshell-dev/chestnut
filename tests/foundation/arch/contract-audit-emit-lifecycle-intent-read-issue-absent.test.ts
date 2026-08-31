import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditEmitSource = readFileSync(
  new URL('../../../src/core/contract/audit-emit.ts', import.meta.url),
  'utf8',
);

describe('Contract emitLifecycleIntentReadIssue dead surface', () => {
  it('has no emitLifecycleIntentReadIssue anywhere in the audit-emit source', () => {
    expect(auditEmitSource).not.toMatch(/\bemitLifecycleIntentReadIssue\b/);
  });

  it('keeps a stable live emit anchor intact', () => {
    expect(auditEmitSource).toMatch(/export\s+function\s+emitContractCreated\(/);
  });
});
