import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/archive-payload-layout.ts', import.meta.url), 'utf8');
describe('ArchivePayloadLayoutSnapshot surface', () => {
  it('keeps strict layout snapshots local between reader and projection', () => {
    expect(source).not.toMatch(/export\s+interface\s+ArchivePayloadLayoutSnapshot\b/);
    expect(source).toMatch(/interface\s+ArchivePayloadLayoutSnapshot\s*{[\s\S]*root:\s*string;[\s\S]*contract:\s*PersistedContractYaml;[\s\S]*subtasks:\s*ReadonlyMap<string,\s*SubtaskRuntimeRecord>;[\s\S]*aggregate:\s*ContractAggregateStatus;/);
    expect(source).toMatch(/readStrictContractLayoutAtRoot\([\s\S]*?\):\s*Promise<ArchivePayloadLayoutSnapshot>/);
    expect(source).toMatch(/projectArchivePayloadRuntime\(layout:\s*ArchivePayloadLayoutSnapshot\)/);
  });
});
