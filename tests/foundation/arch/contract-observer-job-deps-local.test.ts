import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const observerSource = readFileSync(
  new URL('../../../src/core/contract/jobs/contract-observer.ts', import.meta.url),
  'utf8',
);
const barrelSource = readFileSync(
  new URL('../../../src/core/contract/index.ts', import.meta.url),
  'utf8',
);

describe('Contract ContractObserverJobDeps deep surface', () => {
  it('keeps the observer job deps type local behind the job factory', () => {
    expect(observerSource).not.toMatch(/export\s+interface\s+ContractObserverJobDeps\b/);
    expect(observerSource).toMatch(
      /(?:^|\n)interface\s+ContractObserverJobDeps\s*\{\s*\n\s*clawTopology:\s*ClawTopology;\s*\n\s*motionDir:\s*string;\s*\n\s*fs:\s*FileSystem;\s*\n\s*motionAudit:\s*AuditLog;\s*\n\s*notifyMotion:\s*NotifyMotionFn;/,
    );
    expect(observerSource).toMatch(
      /export\s+function\s+createContractObserverJob\(\s*\n\s*deps:\s*ContractObserverJobDeps,/,
    );
    expect(barrelSource).not.toMatch(/\bContractObserverJobDeps\b/);
  });
});
