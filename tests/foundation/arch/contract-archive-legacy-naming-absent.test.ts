import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const readerSource = readFileSync(new URL('../../../src/core/contract/archive-reader.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../../../src/core/contract/types.ts', import.meta.url), 'utf8');
describe('archive legacy naming absence (Phase 1899)', () => {
  it('does not call the flat content format legacy in the archive reader', () => {
    expect(readerSource).not.toMatch(/legacy/i);
  });
  it('does not retain the removed ArchivePayloadLayout/ArchivePayloadState types', () => {
    expect(typesSource).not.toMatch(/ArchivePayloadLayout|ArchivePayloadState/);
  });
});
