import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../../src/foundation/audit/reader.ts', import.meta.url), 'utf8');
const barrel = readFileSync(new URL('../../../src/foundation/audit/index.ts', import.meta.url), 'utf8');

describe('PendingFallbackDump surface', () => {
  it('keeps the scan result carrier local behind listPendingFallbackDumps', () => {
    expect(source).not.toMatch(/export\s+interface\s+PendingFallbackDump\b/);
    expect(source).toMatch(/interface\s+PendingFallbackDump\s*\{[\s\S]*path:\s*string;[\s\S]*pid:\s*number;[\s\S]*ts:\s*number;[\s\S]*size:\s*number;[\s\S]*\}/);
    expect(source).toMatch(/export\s+function\s+listPendingFallbackDumps\(\):\s*PendingFallbackDump\[\]/);
    expect(source).toMatch(/const\s+results:\s*PendingFallbackDump\[\]\s*=\s*\[\]/);
    expect(barrel).not.toMatch(/\bPendingFallbackDump\b/);
  });
});
