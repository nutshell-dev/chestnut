import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/writer.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('pushFallback surface', () => {
  it('keeps fallback enqueueing local behind AuditWriter write handling', () => {
    expect(source).not.toMatch(/export\s+function\s+pushFallback\b/);
    expect(source).toMatch(/function\s+pushFallback\(line:\s*string,\s*origin:\s*string\):\s*void/);
    expect(source).toMatch(/pushFallback\(line,\s*this\.filePath\)/);
    expect(barrel).not.toMatch(/\bpushFallback\b/);
  });
});
