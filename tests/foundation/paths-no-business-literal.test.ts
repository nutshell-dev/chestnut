import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

describe('foundation/paths.ts: no business role literal', () => {
  it('paths.ts contains no business caller role literal', () => {
    const src = readFileSync('src/foundation/paths.ts', 'utf-8');
    const businessRoles = ['motion', 'claw', 'subagent', 'verifier', 'shadow', 'miner'];
    for (const role of businessRoles) {
      // Use quoted literal pattern to avoid substring false positives
      expect(src).not.toMatch(new RegExp(`['"\`]${role}['"\`]`));
    }
  });
});
