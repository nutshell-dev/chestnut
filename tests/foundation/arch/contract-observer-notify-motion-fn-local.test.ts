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

describe('Contract NotifyMotionFn deep surface', () => {
  it('keeps the notify motion callback type local behind the observer options', () => {
    expect(observerSource).not.toMatch(/export\s+type\s+NotifyMotionFn\b/);
    expect(observerSource).toMatch(
      /(?:^|\n)type\s+NotifyMotionFn\s*=\s*\(message:\s*InboxMessageOptionsBase\)\s*=>\s*Promise<void>;/,
    );
    expect(observerSource.match(/\bnotifyMotion:\s*NotifyMotionFn;/g) ?? []).toHaveLength(2);
    expect(observerSource).toMatch(/export\s+async\s+function\s+runContractObserver\(/);
    expect(barrelSource).not.toMatch(/\bNotifyMotionFn\b/);
  });
});
