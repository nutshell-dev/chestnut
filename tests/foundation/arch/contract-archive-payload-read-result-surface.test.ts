import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/archive-reader.ts', import.meta.url), 'utf8');
describe('ArchivePayloadReadResult surface', () => {
  it('keeps the typed result local throughout archive reading', () => {
    expect(source).not.toMatch(/export\s+type\s+ArchivePayloadReadResult\b/);
    expect(source).toMatch(/type\s+ArchivePayloadReadResult\s*=\s*[\s\S]*kind:\s*'found';\s*view:\s*ArchivePayloadView[\s\S]*kind:\s*'issue';\s*issue:\s*ArchiveReadIssue/);
    expect(source.match(/Promise<ArchivePayloadReadResult>/g)).toHaveLength(2);
    expect(source).toMatch(/readArchivePayload\([\s\S]*?\):\s*Promise<ArchivePayloadReadResult>/);
  });
});
