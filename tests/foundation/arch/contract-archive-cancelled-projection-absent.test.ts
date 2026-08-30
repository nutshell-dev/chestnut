import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/archive-reader.ts', import.meta.url), 'utf8');
describe('cancelled archive projection absence', () => {
  it('does not retain the zero-caller projectCancelledReason surface', () => {
    expect(source).not.toMatch(/\bprojectCancelledReason\b/);
    expect(source).toMatch(/export\s+function\s+projectCorruptedCause\b/);
    expect(source).toMatch(/export\s+function\s+projectFailedFailure\b/);
  });
});
