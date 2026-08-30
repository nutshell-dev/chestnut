import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/core/contract/_isolation-helper.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/core/contract/index.ts', import.meta.url), 'utf8');

describe('IsolationResult surface', () => {
  it('keeps the result carrier local behind isolateCorruptedFile', () => {
    expect(source).not.toMatch(/export\s+interface\s+IsolationResult\b/);
    expect(source).toMatch(/interface\s+IsolationResult\s*{[\s\S]*backupPath:\s*string;[\s\S]*relativePath:\s*string;[\s\S]*}/);
    expect(source).toMatch(/export\s+async\s+function\s+isolateCorruptedFile\([\s\S]*?\):\s*Promise<IsolationResult\s*\|\s*null>/);
    expect(barrel).not.toMatch(/\bIsolationResult\b/);
  });
});
