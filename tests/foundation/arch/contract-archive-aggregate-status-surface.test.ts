import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/archive-payload-layout.ts', import.meta.url), 'utf8');
describe('ContractAggregateStatus surface', () => {
  it('keeps the aggregate union local with its derivation bindings', () => {
    expect(source).not.toMatch(/export\s+type\s+ContractAggregateStatus\b/);
    expect(source).toMatch(/type\s+ContractAggregateStatus\s*=\s*'pending'\s*\|\s*'running'\s*\|\s*'completed'/);
    expect(source).toMatch(/aggregate:\s*ContractAggregateStatus;/);
    expect(source).toMatch(/deriveContractAggregate\([\s\S]*?\):\s*ContractAggregateStatus/);
    expect(source).toMatch(/mapContractAggregateToDerivable\(aggregate:\s*ContractAggregateStatus\)/);
  });
});
