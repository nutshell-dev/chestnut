import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/archive-payload-layout.ts', import.meta.url), 'utf8');
describe('ArchivePayloadRuntimeView surface', () => {
  it('keeps the projection carrier local with contract and progress', () => {
    expect(source).not.toMatch(/export\s+interface\s+ArchivePayloadRuntimeView\b/);
    expect(source).toMatch(/interface\s+ArchivePayloadRuntimeView\s*{[\s\S]*contract:\s*Contract;[\s\S]*progress:\s*ProgressData;/);
    expect(source).toMatch(/projectArchivePayloadRuntime\(layout:\s*ArchivePayloadLayoutSnapshot\):\s*ArchivePayloadRuntimeView/);
  });
});
