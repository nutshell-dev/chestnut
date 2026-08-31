import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const auditEmitSource = readFileSync(
  new URL('../../../src/core/contract/audit-emit.ts', import.meta.url),
  'utf8',
);

describe('Contract emitContractVerificationPipelineRaceRejected dead surface', () => {
  it('has no emitContractVerificationPipelineRaceRejected anywhere in the audit-emit source', () => {
    expect(auditEmitSource).not.toMatch(/\bemitContractVerificationPipelineRaceRejected\b/);
  });

  it('keeps a stable live emit anchor intact', () => {
    expect(auditEmitSource).toMatch(/export\s+function\s+emitContractCreated\(/);
  });
});
