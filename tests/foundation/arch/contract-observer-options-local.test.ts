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

describe('Contract ContractObserverOptions deep surface', () => {
  it('keeps the observer options type local behind runContractObserver', () => {
    expect(observerSource).not.toMatch(/export\s+interface\s+ContractObserverOptions\b/);
    expect(observerSource).toMatch(
      /(?:^|\n)interface\s+ContractObserverOptions\s*\{[\s\S]*?clawTopology:\s*ClawTopology;[\s\S]*?notifyMotion:\s*NotifyMotionFn;[\s\S]*?signal\?:\s*AbortSignal;\s*\n\}/,
    );
    expect(observerSource).toMatch(
      /export\s+async\s+function\s+runContractObserver\(options:\s*ContractObserverOptions\):\s*Promise<void>/,
    );
    expect(barrelSource).not.toMatch(/\bContractObserverOptions\b/);
  });
});
