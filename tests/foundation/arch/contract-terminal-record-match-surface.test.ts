import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../../src/core/contract/archive-terminal-event.ts', import.meta.url), 'utf8');
describe('TerminalRecordMatch surface', () => {
  it('keeps the three-state matcher result local', () => {
    expect(source).not.toMatch(/export\s+type\s+TerminalRecordMatch\b/);
    expect(source).toMatch(/type\s+TerminalRecordMatch\s*=\s*[\s\S]*kind:\s*'match';\s*recordedAt:\s*string;\s*seq:\s*number[\s\S]*kind:\s*'no-match'[\s\S]*kind:\s*'invalid';\s*reason:\s*TerminalRecordInvalidReason/);
    expect(source).toMatch(/matchArchiveTerminalRecord\([\s\S]*?\):\s*TerminalRecordMatch/);
  });
});
