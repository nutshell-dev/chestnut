import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const layoutSource = readFileSync(new URL('../../../src/core/contract/archive-payload-layout.ts', import.meta.url), 'utf8');
const readerSource = readFileSync(new URL('../../../src/core/contract/archive-reader.ts', import.meta.url), 'utf8');
describe('archive strict reader absence (Phase 1898)', () => {
  it('does not retain the removed strict subtasks/ read half', () => {
    expect(layoutSource).not.toMatch(/\breadStrictContractLayoutAtRoot\b/);
    expect(layoutSource).not.toMatch(/\bprojectArchivePayloadRuntime\b/);
    expect(readerSource).not.toMatch(/\breadCurrentArchivePayload\b/);
  });
});
