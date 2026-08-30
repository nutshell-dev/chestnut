import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/lightweight-read.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('LightweightResult surface', () => {
  it('keeps the result carrier local behind lightweight read operations', () => {
    expect(source).not.toMatch(/export\s+type\s+LightweightResult\b/);
    expect(source).toMatch(/type\s+LightweightResult<T>\s*=\s*[\s\S]*ok:\s*true;\s*value:\s*T[\s\S]*ok:\s*false;\s*error:\s*'not_found'\s*\|\s*'io_error'/);
    expect(source).toMatch(/auditFileContains\([\s\S]*?\):\s*LightweightResult<boolean>/);
    expect(source).toMatch(/auditFirstTimestamp\([\s\S]*?\):\s*LightweightResult<string\s*\|\s*null>/);
    expect(source).toMatch(/auditFileGetMtime\([\s\S]*?\):\s*LightweightResult<number\s*\|\s*null>/);
    expect(barrel).not.toMatch(/\bLightweightResult\b/);
  });
});
