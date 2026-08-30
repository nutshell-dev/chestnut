import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/archive-terminal-event.ts', import.meta.url), 'utf8');
describe('TerminalRecordInvalidReason surface', () => {
  it('keeps invalid reasons local behind the match union', () => {
    expect(source).not.toMatch(/export\s+type\s+TerminalRecordInvalidReason\b/);
    expect(source).toMatch(/type\s+TerminalRecordInvalidReason\s*=\s*[\s\S]*'id_conflict'[\s\S]*'invalid_timestamp'/);
    expect(source).toMatch(/kind:\s*'invalid';\s*reason:\s*TerminalRecordInvalidReason/);
  });
});
