import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const BAN_PATTERNS = [
  // fs.(read|exists)Sync? against contract.yaml / progress.json in CLI scope
  String.raw`fs\.(read|exists)\w*Sync\?[^\n]*(contract\.yaml|progress\.json)`,
];

describe('CLI 区不得直读 contract.yaml / progress.json', () => {
  for (const pattern of BAN_PATTERNS) {
    it(`grep -rnE '${pattern}' src/cli/ 应 0 hit`, () => {
      let out = '';
      try {
        out = execSync(
          `grep -rnE '${pattern}' src/cli/`,
          { encoding: 'utf-8' },
        ).trim();
      } catch (err: any) {
        // grep exit 1 = 0 match = expected
        if (err.status !== 1) throw err;
        out = '';
      }
      expect(out, `Forbidden direct fs read of contract resource in src/cli/:\n${out}`).toBe('');
    });
  }
});
