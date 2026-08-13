import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AuditReader polling lifecycle invariant (phase 1381)', () => {
  it('uses the closed flag without a dead interval watcher lifecycle', () => {
    const source = readFileSync('src/foundation/audit/reader.ts', 'utf8');

    expect(source).toContain('while (!closed)');
    expect(source).not.toMatch(/\b(?:let|const|var)\s+watcher\b/);
    expect(source).not.toMatch(/\b(?:setInterval|clearInterval)\s*\(/);
  });
});
